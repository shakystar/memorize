import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let sandbox: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

function runHook(eventName: string, stdinPayload: object) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'hook', 'claude', eventName], {
    cwd: sandbox,
    input: JSON.stringify(stdinPayload),
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
    },
  });
}

function runCli(args: string[]) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
    },
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-hook-lifecycle-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(join(sandbox, '.cursor', 'rules'), { recursive: true });
  await writeFile(
    join(sandbox, 'AGENTS.md'),
    '# Project guidance\nUse small commits and keep handoffs explicit.\n',
    'utf8',
  );
  await writeFile(
    join(sandbox, 'CLAUDE.md'),
    '# Claude guidance\nPrioritize architectural consistency.\n',
    'utf8',
  );
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('claude hook lifecycle', () => {
  it('creates checkpoint artifacts on PostCompact', async () => {
    const sessionStart = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'session_1',
    });
    expect(sessionStart.status).toBe(0);

    const result = runHook('PostCompact', {
      cwd: sandbox,
      hook_event_name: 'PostCompact',
      session_id: 'session_1',
      compact_summary: 'Summarized recent progress',
    });

    expect(result.status).toBe(0);
    // PostCompact output must be a plain top-level `systemMessage` —
    // Claude Code rejects a `hookSpecificOutput` block on this event.
    expect(result.stdout).not.toContain('"hookSpecificOutput"');
    expect(result.stdout).toContain('"systemMessage"');
    expect(result.stdout).toContain('memorize: checkpoint');

    const projectsRoot = join(memorizeRoot, 'projects');
    const projectDirs = await readdir(projectsRoot);
    const checkpointsDir = join(projectsRoot, projectDirs[0]!, 'checkpoints');
    const checkpointFiles = await readdir(checkpointsDir);
    expect(checkpointFiles.length).toBeGreaterThan(0);
  });

  it('Stop hook is a no-op (β redesign — handoffs are agent-initiated, not per-turn)', async () => {
    // rc.0..rc.4 wired Stop to auto-create a handoff every time the
    // assistant finished a turn. That conflated "turn end" with
    // "session end" and produced one bogus handoff per turn. β model:
    // Stop returns `{}`, agents call `memorize handoff create`
    // explicitly when they actually want to hand off.
    const sessionStart = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'session_2',
    });
    expect(sessionStart.status).toBe(0);

    runCli(['task', 'create', 'Test task']);

    const result = runHook('Stop', {
      cwd: sandbox,
      hook_event_name: 'Stop',
      session_id: 'session_2',
      last_assistant_message: 'Finished the current pass.',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    const projectsRoot = join(memorizeRoot, 'projects');
    const projectDirs = await readdir(projectsRoot);
    const handoffsDir = join(projectsRoot, projectDirs[0]!, 'handoffs');
    const handoffFiles = await readdir(handoffsDir).catch(() => []);
    expect(handoffFiles.length).toBe(0);
  });

  it('SessionEnd hook pauses the session and PRESERVES the cwd pointer for resume', async () => {
    // Model C lifecycle (post rc.11): SessionEnd writes a session.paused
    // event and intentionally KEEPS the cwd pointer. The pointer is the
    // only artifact `resolveByAgentSessionId` can match on, so deleting
    // it (the pre-Model-C `endSession` behavior) was what broke
    // "1 agent conversation = 1 memorize session" across `claude --resume`.
    // Reap still catches paused sessions that go stale without a resume.
    const sessionStart = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'c0000000-0000-0000-0000-000000000099',
    });
    expect(sessionStart.status).toBe(0);

    const sessionsBefore = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(sessionsBefore.length).toBe(1);
    const memorizeSessionId = sessionsBefore[0]!.replace(/\.json$/, '');

    // Production env propagation goes through CLAUDE_ENV_FILE → source →
    // exported MEMORIZE_SESSION_ID; in-test we pass it directly so the
    // SessionEnd subprocess can resolve the pointer.
    const sessionEnd = spawnSync(
      'node',
      [tsxCliPath, cliEntryPath, 'hook', 'claude', 'SessionEnd'],
      {
        cwd: sandbox,
        input: JSON.stringify({
          cwd: sandbox,
          hook_event_name: 'SessionEnd',
          session_id: 'c0000000-0000-0000-0000-000000000099',
          reason: 'logout',
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          MEMORIZE_ROOT: memorizeRoot,
          MEMORIZE_SESSION_ID: memorizeSessionId,
        },
      },
    );
    expect(sessionEnd.status).toBe(0);

    // Cwd pointer SURVIVES — this is the whole point of pause vs end.
    const sessionsAfter = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(sessionsAfter).toEqual([`${memorizeSessionId}.json`]);

    // session.paused event landed in the project log; no session.completed.
    const projectsRoot = join(memorizeRoot, 'projects');
    const projectDirs = await readdir(projectsRoot);
    const events = await readdir(join(projectsRoot, projectDirs[0]!, 'events'));
    let sawPaused = false;
    let sawCompleted = false;
    for (const ev of events) {
      const body = await readFile(
        join(projectsRoot, projectDirs[0]!, 'events', ev),
        'utf8',
      );
      if (body.includes('"session.paused"')) sawPaused = true;
      if (body.includes('"session.completed"')) sawCompleted = true;
    }
    expect(sawPaused).toBe(true);
    expect(sawCompleted).toBe(false);

    // Projection reflects the paused status — picker can use this
    // signal even though the cwd pointer alone doesn't carry status.
    const sessionFile = join(
      projectsRoot,
      projectDirs[0]!,
      'sessions',
      `${memorizeSessionId}.json`,
    );
    const sessionRecord = JSON.parse(await readFile(sessionFile, 'utf8'));
    expect(sessionRecord.status).toBe('paused');
  });

  it('SessionStart with a known agent UUID reuses the existing pointer (resume seamless)', async () => {
    // Simulates `claude --resume <uuid>`: a fresh SessionStart hook
    // fires, but its session_id matches the UUID we stamped on a prior
    // pointer. The handler must reuse that pointer (no new
    // session.started event, no new sessions/<id>.json file) and emit
    // a session.resumed event so the projection sees fresh activity.
    // This is what preserves "1 agent conversation = 1 memorize
    // session" for users who routinely resume role-assigned sessions.
    const claudeUuid = '11111111-2222-3333-4444-555555555555';
    const first = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: claudeUuid,
    });
    expect(first.status).toBe(0);

    const sessionsBefore = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(sessionsBefore.length).toBe(1);
    const memorizeSessionId = sessionsBefore[0]!.replace(/\.json$/, '');

    const second = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: claudeUuid,
      source: 'resume',
    });
    expect(second.status).toBe(0);

    // Same single pointer, same memorize session id — no new session
    // file was created.
    const sessionsAfter = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(sessionsAfter).toEqual([`${memorizeSessionId}.json`]);

    // Exactly one session.started event in the log; at least one
    // session.resumed event followed it.
    const projectsRoot = join(memorizeRoot, 'projects');
    const projectDirs = await readdir(projectsRoot);
    const events = await readdir(join(projectsRoot, projectDirs[0]!, 'events'));
    let started = 0;
    let resumed = 0;
    for (const ev of events) {
      const body = await readFile(
        join(projectsRoot, projectDirs[0]!, 'events', ev),
        'utf8',
      );
      if (body.includes('"session.started"')) started += 1;
      if (body.includes('"session.resumed"')) resumed += 1;
    }
    expect(started).toBe(1);
    expect(resumed).toBeGreaterThanOrEqual(1);
  });

  it('SessionEnd resolves via payload.session_id when MEMORIZE_SESSION_ID env is missing, and emits session.paused', async () => {
    // The empirical finding from rc.5 dogfood: Claude does NOT
    // propagate MEMORIZE_SESSION_ID into the SessionEnd hook
    // subprocess (despite SessionStart's exported env reaching every
    // other tool/Bash subprocess). The β safety net is to stamp the
    // agent's own session id (Claude UUID) on the cwd pointer at
    // SessionStart, then look it up here from payload.session_id.
    // Model C addition: even when the resolution path works, we now
    // pause (not end) the session so the pointer survives for resume.
    const claudeUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sessionStart = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: claudeUuid,
    });
    expect(sessionStart.status).toBe(0);

    const memorizeSessionId = (
      await readdir(join(sandbox, '.memorize', 'sessions'))
    )[0]!.replace(/\.json$/, '');

    // Drive SessionEnd with NO MEMORIZE_SESSION_ID env, only the
    // payload session_id — the production failure mode.
    const sessionEnd = spawnSync(
      'node',
      [tsxCliPath, cliEntryPath, 'hook', 'claude', 'SessionEnd'],
      {
        cwd: sandbox,
        input: JSON.stringify({
          cwd: sandbox,
          hook_event_name: 'SessionEnd',
          session_id: claudeUuid,
          reason: 'other',
        }),
        encoding: 'utf8',
        env: { ...process.env, MEMORIZE_ROOT: memorizeRoot },
      },
    );
    expect(sessionEnd.status).toBe(0);

    // Pointer survives — Model C invariant.
    const sessionsAfter = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(sessionsAfter).toEqual([`${memorizeSessionId}.json`]);

    const projectDirs = await readdir(join(memorizeRoot, 'projects'));
    const events = await readdir(join(memorizeRoot, 'projects', projectDirs[0]!, 'events'));
    let sawPaused = false;
    for (const ev of events) {
      const body = await readFile(
        join(memorizeRoot, 'projects', projectDirs[0]!, 'events', ev),
        'utf8',
      );
      if (body.includes('"session.paused"')) sawPaused = true;
    }
    expect(sawPaused).toBe(true);
  });

  it('SessionEnd → SessionStart resume cycle keeps the same memorize session and flips status paused→active', async () => {
    // Model C end-to-end: a Claude session exits cleanly (status
    // becomes 'paused', pointer survives), then `claude --resume`
    // fires another SessionStart with the same UUID. The resume
    // detection path matches the surviving pointer by agentSessionId
    // and emits session.resumed; the projector flips status back to
    // 'active'. Same memorize session id throughout — this is what
    // "1 agent conversation = 1 memorize session" means in practice.
    const claudeUuid = 'fffffffe-0000-1111-2222-333333333333';

    const start1 = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: claudeUuid,
    });
    expect(start1.status).toBe(0);

    const memorizeSessionId = (
      await readdir(join(sandbox, '.memorize', 'sessions'))
    )[0]!.replace(/\.json$/, '');

    // Pause it.
    const end = spawnSync(
      'node',
      [tsxCliPath, cliEntryPath, 'hook', 'claude', 'SessionEnd'],
      {
        cwd: sandbox,
        input: JSON.stringify({
          cwd: sandbox,
          hook_event_name: 'SessionEnd',
          session_id: claudeUuid,
          reason: 'logout',
        }),
        encoding: 'utf8',
        env: { ...process.env, MEMORIZE_ROOT: memorizeRoot },
      },
    );
    expect(end.status).toBe(0);

    const projectDirs = await readdir(join(memorizeRoot, 'projects'));
    const sessionFile = join(
      memorizeRoot,
      'projects',
      projectDirs[0]!,
      'sessions',
      `${memorizeSessionId}.json`,
    );
    expect(JSON.parse(await readFile(sessionFile, 'utf8')).status).toBe('paused');

    // Resume.
    const start2 = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: claudeUuid,
      source: 'resume',
    });
    expect(start2.status).toBe(0);

    // Same single pointer, same session id (no second session minted).
    const sessionsAfter = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(sessionsAfter).toEqual([`${memorizeSessionId}.json`]);

    // Status flipped back to active.
    expect(JSON.parse(await readFile(sessionFile, 'utf8')).status).toBe('active');
  });
});
