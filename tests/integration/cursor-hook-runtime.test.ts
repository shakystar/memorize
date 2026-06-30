import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAll, getDb } from '../../src/storage/db.js';
import { readEvents } from '../../src/storage/event-store.js';

let sandbox: string;
let fakeHome: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

const baseEnv = () => ({
  ...process.env,
  MEMORIZE_ROOT: memorizeRoot,
  HOME: fakeHome,
  USERPROFILE: fakeHome,
  MEMORIZE_DETECT_PATH: '',
});

function runInit() {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'init'], {
    cwd: sandbox,
    encoding: 'utf8',
    env: baseEnv(),
  });
}

function runCursorHook(event: string, payload: object) {
  return runHarnessHook('cursor', event, JSON.stringify(payload));
}

function runHarnessHook(harness: string, event: string, input: string) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'hook', harness, event], {
    cwd: sandbox,
    input,
    encoding: 'utf8',
    env: baseEnv(),
  });
}

function runHook(harness: 'claude' | 'cursor', event: string, payload: object) {
  return runHarnessHook(harness, event, JSON.stringify(payload));
}

function runHookRaw(harness: 'claude' | 'cursor', event: string, input: string) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'hook', harness, event], {
    cwd: sandbox,
    input,
    encoding: 'utf8',
    env: baseEnv(),
  });
}

function cursorPayload(sessionId: string, hookEventName: string, extra = {}) {
  return {
    hook_event_name: hookEventName,
    session_id: sessionId,
    conversation_id: 'cursor-conversation-1',
    generation_id: `cursor-generation-${hookEventName}`,
    cursor_version: '1.0.0-test',
    workspace_roots: [sandbox],
    transcript_path: join(sandbox, 'cursor-transcript.jsonl'),
    ...extra,
  };
}

async function readFirstProjectEvents() {
  const previous = process.env.MEMORIZE_ROOT;
  process.env.MEMORIZE_ROOT = memorizeRoot;
  closeAll();
  try {
    const projectIds = await readdir(join(memorizeRoot, 'projects'));
    const projectId = projectIds[0]!;
    return { projectId, events: await readEvents(projectId) };
  } finally {
    closeAll();
    if (previous === undefined) {
      delete process.env.MEMORIZE_ROOT;
    } else {
      process.env.MEMORIZE_ROOT = previous;
    }
  }
}

async function checkpointCount(): Promise<number> {
  const { projectId } = await readFirstProjectEvents();
  const previous = process.env.MEMORIZE_ROOT;
  process.env.MEMORIZE_ROOT = memorizeRoot;
  closeAll();
  try {
    return (
      getDb(projectId).prepare('SELECT COUNT(*) AS n FROM checkpoints').get() as {
        n: number;
      }
    ).n;
  } finally {
    closeAll();
    if (previous === undefined) {
      delete process.env.MEMORIZE_ROOT;
    } else {
      process.env.MEMORIZE_ROOT = previous;
    }
  }
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-cursor-rt-'));
  fakeHome = join(sandbox, 'fake-home');
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(fakeHome, { recursive: true });
  // cursor auto-binds (project-scoped hooks), but init makes the binding
  // explicit so the run is deterministic regardless of auto-bind ordering.
  expect(runInit().status).toBe(0);
});

afterEach(async () => {
  closeAll();
  await rm(sandbox, { recursive: true, force: true });
});

describe('cursor hook runtime — additional_context wire translation', () => {
  it('sessionStart injects memory under the native {additional_context} field, not Claude’s envelope', async () => {
    const out = runCursorHook('sessionStart', {
      hook_event_name: 'sessionStart',
      session_id: 'cursor_sess_1',
      cwd: sandbox,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout) as { additional_context?: string };
    expect(typeof parsed.additional_context).toBe('string');
    expect(parsed.additional_context!.length).toBeGreaterThan(0);
    // Translation, not passthrough: the Claude-only envelope must be gone, and
    // the field must be snake_case (cursor), not camelCase (claude).
    expect(out.stdout).not.toContain('hookSpecificOutput');
    expect(out.stdout).not.toContain('additionalContext');
  });

  it('postToolUse (Shell) runs capture and emits no context envelope when no sibling is active', async () => {
    const out = runCursorHook('postToolUse', {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'rm -rf build' },
      cwd: sandbox,
    });
    expect(out.status).toBe(0);
    // No parallel session → live-update is silent → empty envelope.
    expect(out.stdout.replace(/\s/g, '')).toBe('{}');
  });

  it('preCompact and sessionEnd are boundaries: they emit no context envelope', async () => {
    const precompact = runCursorHook('preCompact', {
      hook_event_name: 'preCompact',
      session_id: 'cursor_sess_1',
      cwd: sandbox,
    });
    expect(precompact.status).toBe(0);
    // PostCompact handler returns {systemMessage}; the cursor wire renderer
    // collapses every non-context result to {}.
    expect(precompact.stdout).not.toContain('additional_context');

    const sessionEnd = runCursorHook('sessionEnd', {
      hook_event_name: 'sessionEnd',
      session_id: 'cursor_sess_1',
      cwd: sandbox,
    });
    expect(sessionEnd.status).toBe(0);
    expect(sessionEnd.stdout).not.toContain('additional_context');
  });

  it('attributes Cursor-origin Claude compatibility SessionStart to cursor and reuses the native session', async () => {
    const payload = cursorPayload('cursor_dual_session_start', 'sessionStart', {
      cwd: sandbox,
    });

    expect(runHook('claude', 'SessionStart', payload).status).toBe(0);
    expect(runHook('cursor', 'sessionStart', payload).status).toBe(0);

    const { events } = await readFirstProjectEvents();
    const started = events.filter((event) => event.type === 'session.started');
    expect(started).toHaveLength(1);
    expect(started[0]!.actor).toBe('cursor');
    expect((started[0]!.payload as { actor: string }).actor).toBe('cursor');
  });

  it('dedupes Cursor native and Claude compatibility postToolUse captures by tool_use_id', async () => {
    const sessionId = 'cursor_dual_post_tool_use';
    expect(
      runHook(
        'cursor',
        'sessionStart',
        cursorPayload(sessionId, 'sessionStart', { cwd: sandbox }),
      ).status,
    ).toBe(0);

    const payload = cursorPayload(sessionId, 'postToolUse', {
      cwd: sandbox,
      generation_id: 'cursor-generation-post-tool-use-1',
      tool_use_id: 'tool_cursor_duplicate_1',
      tool_name: 'Write',
      tool_input: { file_path: join(sandbox, 'dedupe.ts'), content: 'x' },
    });
    const rawPayload = `\uFEFF${JSON.stringify(payload)}`;

    expect(runHookRaw('claude', 'PostToolUse', rawPayload).status).toBe(0);
    expect(runHookRaw('cursor', 'postToolUse', rawPayload).status).toBe(0);

    const { events } = await readFirstProjectEvents();
    const observations = events.filter(
      (event) => event.type === 'observation.captured',
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]!.actor).toBe('cursor');
    expect(
      (observations[0]!.payload as { toolUseId?: string }).toolUseId,
    ).toBe('tool_cursor_duplicate_1');
  });

  it('dedupes Cursor native and Claude compatibility preCompact checkpoints', async () => {
    const sessionId = 'cursor_dual_pre_compact';
    expect(
      runHook(
        'cursor',
        'sessionStart',
        cursorPayload(sessionId, 'sessionStart', { cwd: sandbox }),
      ).status,
    ).toBe(0);

    const payload = cursorPayload(sessionId, 'preCompact', {
      cwd: sandbox,
      generation_id: 'cursor-generation-pre-compact-1',
      compact_summary: 'Cursor preCompact summary',
    });
    expect(runHook('claude', 'PostCompact', payload).status).toBe(0);
    expect(runHook('cursor', 'preCompact', payload).status).toBe(0);

    expect(await checkpointCount()).toBe(1);
    const { events } = await readFirstProjectEvents();
    const checkpoints = events.filter((event) => event.type === 'checkpoint.created');
    expect(checkpoints).toHaveLength(1);
    expect(
      (checkpoints[0]!.payload as { sourceHookId?: string }).sourceHookId,
    ).toContain('cursor:PostCompact:');
  });

  it('dedupes Cursor native and Claude compatibility sessionEnd pause events', async () => {
    const sessionId = 'cursor_dual_session_end';
    expect(
      runHook(
        'cursor',
        'sessionStart',
        cursorPayload(sessionId, 'sessionStart', { cwd: sandbox }),
      ).status,
    ).toBe(0);

    const payload = cursorPayload(sessionId, 'sessionEnd', {
      cwd: sandbox,
      reason: 'logout',
    });
    expect(runHook('claude', 'SessionEnd', payload).status).toBe(0);
    expect(runHook('cursor', 'sessionEnd', payload).status).toBe(0);

    const { events } = await readFirstProjectEvents();
    const paused = events.filter((event) => event.type === 'session.paused');
    expect(paused).toHaveLength(1);
    expect(paused[0]!.actor).toBe('cursor');
  });
});
