import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSessionContext } from '../../src/services/session-context.js';
import { SESSION_ENV_VAR } from '../../src/storage/cwd-session-store.js';

let sandbox: string;

async function plantPointer(
  pointer: Record<string, unknown> & { sessionId: string },
): Promise<void> {
  const dir = join(sandbox, '.memorize', 'sessions');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${pointer.sessionId}.json`),
    JSON.stringify(pointer, null, 2),
    'utf8',
  );
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-session-ctx-'));
  delete process.env[SESSION_ENV_VAR];
});

afterEach(async () => {
  delete process.env[SESSION_ENV_VAR];
  await rm(sandbox, { recursive: true, force: true });
});

describe('resolveSessionContext — single source of truth for "which session am I?"', () => {
  it('returns resolvedVia: none when there are no pointers', async () => {
    const ctx = await resolveSessionContext(sandbox);
    expect(ctx).toEqual({ resolvedVia: 'none' });
  });

  it('matches by env (MEMORIZE_SESSION_ID) when the env var is set', async () => {
    await plantPointer({
      sessionId: 'session_env_target',
      startedAt: '2026-05-05T00:00:00.000Z',
      startedBy: 'claude',
      projectId: 'proj_env',
      taskId: 'task_env',
    });
    await plantPointer({
      sessionId: 'session_other',
      startedAt: '2026-05-05T00:00:01.000Z',
      startedBy: 'codex',
      projectId: 'proj_env',
      taskId: 'task_other',
    });

    process.env[SESSION_ENV_VAR] = 'session_env_target';
    const ctx = await resolveSessionContext(sandbox);
    expect(ctx.resolvedVia).toBe('env');
    expect(ctx.sessionId).toBe('session_env_target');
    expect(ctx.actor).toBe('claude');
    expect(ctx.taskId).toBe('task_env');
  });

  it('matches by agent-pid when env is missing and an ancestor pid is stamped on a pointer', async () => {
    // The test process's parent (vitest) is a real ancestor; planting
    // its pid as agentPid simulates the production case where
    // SessionStart stamped the codex/claude pid on the pointer and
    // a subsequent CLI subprocess walks up to find it.
    await plantPointer({
      sessionId: 'session_pid_match',
      startedAt: '2026-05-05T00:00:00.000Z',
      startedBy: 'codex',
      projectId: 'proj_pid',
      taskId: 'task_pid',
      agentPid: process.ppid,
    });

    const ctx = await resolveSessionContext(sandbox);
    expect(ctx.resolvedVia).toBe('agent-pid');
    expect(ctx.sessionId).toBe('session_pid_match');
    expect(ctx.actor).toBe('codex');
    expect(ctx.taskId).toBe('task_pid');
  });

  it('env match wins over agent-pid match (env is the cheap, exact path)', async () => {
    await plantPointer({
      sessionId: 'session_env_wins',
      startedAt: '2026-05-05T00:00:00.000Z',
      startedBy: 'claude',
    });
    await plantPointer({
      sessionId: 'session_pid_loses',
      startedAt: '2026-05-05T00:00:01.000Z',
      startedBy: 'codex',
      agentPid: process.ppid,
    });

    process.env[SESSION_ENV_VAR] = 'session_env_wins';
    const ctx = await resolveSessionContext(sandbox);
    expect(ctx.resolvedVia).toBe('env');
    expect(ctx.sessionId).toBe('session_env_wins');
  });

  it('matches by agent-env (CODEX_THREAD_ID) when codex propagates its own thread UUID', async () => {
    // Round-5 dogfood: codex CLI subprocesses inherit
    // CODEX_THREAD_ID = the codex session UUID, which we stamp as
    // agentSessionId on the cwd pointer at SessionStart. This path
    // closes the macOS reparenting hole that broke agent-pid walk
    // for codex (workers detach to launchd, ancestor chain never
    // reaches codex root pid).
    await plantPointer({
      sessionId: 'session_codex',
      startedAt: '2026-05-05T00:00:00.000Z',
      startedBy: 'codex',
      projectId: 'proj_codex',
      taskId: 'task_codex',
      agentSessionId: '019df8e4-8a1c-77f1-8d50-8ca03980b4a7',
    });
    process.env.CODEX_THREAD_ID = '019df8e4-8a1c-77f1-8d50-8ca03980b4a7';
    try {
      const ctx = await resolveSessionContext(sandbox);
      expect(ctx.resolvedVia).toBe('agent-env');
      expect(ctx.sessionId).toBe('session_codex');
      expect(ctx.taskId).toBe('task_codex');
      expect(ctx.actor).toBe('codex');
    } finally {
      delete process.env.CODEX_THREAD_ID;
    }
  });

  it('our env (MEMORIZE_SESSION_ID) wins over agent-env (CODEX_THREAD_ID)', async () => {
    // Belt and suspenders: when both envs are present and point at
    // different pointers, our explicit injection wins. The codex
    // env path is the codex-only fallback for the case where our
    // injection never happened.
    await plantPointer({
      sessionId: 'session_ours',
      startedAt: '2026-05-05T00:00:00.000Z',
      startedBy: 'codex',
    });
    await plantPointer({
      sessionId: 'session_codex_native',
      startedAt: '2026-05-05T00:00:01.000Z',
      startedBy: 'codex',
      agentSessionId: '019df8e4-8a1c-77f1-8d50-8ca03980b4a7',
    });
    process.env[SESSION_ENV_VAR] = 'session_ours';
    process.env.CODEX_THREAD_ID = '019df8e4-8a1c-77f1-8d50-8ca03980b4a7';
    try {
      const ctx = await resolveSessionContext(sandbox);
      expect(ctx.resolvedVia).toBe('env');
      expect(ctx.sessionId).toBe('session_ours');
    } finally {
      delete process.env.CODEX_THREAD_ID;
    }
  });

  it('CODEX_THREAD_ID with no matching pointer falls through to later paths (does not return wrong session)', async () => {
    await plantPointer({
      sessionId: 'session_unrelated',
      startedAt: '2026-05-05T00:00:00.000Z',
      startedBy: 'codex',
      agentSessionId: 'totally-different-uuid',
    });
    process.env.CODEX_THREAD_ID = '019df8e4-8a1c-77f1-8d50-8ca03980b4a7';
    try {
      const ctx = await resolveSessionContext(sandbox);
      // No agent-pid stamped, no tty, allowMostRecent off → none.
      // Critical: must NOT silently return the unrelated pointer
      // just because it's a codex session.
      expect(ctx.resolvedVia).toBe('none');
    } finally {
      delete process.env.CODEX_THREAD_ID;
    }
  });

  it('refuses most-recent fallback by default (telemetry callers prefer silent miss to wrong attribution)', async () => {
    // No env, no agent-pid stamp, no tty — only an unrelated pointer
    // exists. Without opt-in, the resolver returns nothing rather
    // than guessing — protects callers like bumpHeartbeat and
    // endSession from cross-attributing to an unrelated session.
    await plantPointer({
      sessionId: 'session_unrelated',
      startedAt: '2026-05-05T00:00:00.000Z',
      startedBy: 'codex',
    });
    const ctx = await resolveSessionContext(sandbox);
    expect(ctx.resolvedVia).toBe('none');
  });

  it('opts in to most-recent fallback when allowMostRecent: true', async () => {
    await plantPointer({
      sessionId: 'session_old',
      startedAt: '2026-05-05T00:00:00.000Z',
      startedBy: 'codex',
    });
    await plantPointer({
      sessionId: 'session_newer',
      startedAt: '2026-05-05T00:00:05.000Z',
      startedBy: 'codex',
    });
    const ctx = await resolveSessionContext(sandbox, { allowMostRecent: true });
    expect(ctx.resolvedVia).toBe('most-recent');
    expect(ctx.sessionId).toBe('session_newer');
  });
});

describe('resolveSessionContext — MEMORIZE_DEBUG instrumentation', () => {
  // The dogfood gap that prompted this: codex `task resume` returned
  // the wrong task while same-session `task handoff` attributed
  // correctly. Without per-call-site visibility into which path the
  // resolver actually took, we can't tell whether the resume CLI hit
  // a different branch (env-miss → tty-miss → none) than handoff did.
  // The debug emit is the cheapest way to expose `resolvedVia` per
  // call site in the next dogfood round.
  let stderrCalls: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrCalls = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrCalls.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    delete process.env.MEMORIZE_DEBUG;
  });

  it('emits nothing when MEMORIZE_DEBUG is unset, even with a debugLabel', async () => {
    delete process.env.MEMORIZE_DEBUG;
    await resolveSessionContext(sandbox, { debugLabel: 'task-resume' });
    expect(stderrCalls.filter((s) => s.includes('memorize-debug'))).toHaveLength(0);
  });

  it('emits nothing when MEMORIZE_DEBUG is set but no debugLabel is passed', async () => {
    process.env.MEMORIZE_DEBUG = '1';
    await resolveSessionContext(sandbox);
    expect(stderrCalls.filter((s) => s.includes('memorize-debug'))).toHaveLength(0);
  });

  it('emits one tagged line when both MEMORIZE_DEBUG and debugLabel are set', async () => {
    await plantPointer({
      sessionId: 'session_debug',
      startedAt: '2026-05-05T00:00:00.000Z',
      startedBy: 'codex',
      projectId: 'proj_debug',
      taskId: 'task_debug',
    });
    process.env[SESSION_ENV_VAR] = 'session_debug';
    process.env.MEMORIZE_DEBUG = '1';

    await resolveSessionContext(sandbox, { debugLabel: 'task-resume' });
    const debugLines = stderrCalls.filter((s) => s.includes('memorize-debug'));
    expect(debugLines).toHaveLength(1);
    const line = debugLines[0]!;
    expect(line).toContain('label=task-resume');
    expect(line).toContain('via=env');
    expect(line).toContain('session=session_debug');
    expect(line).toContain('task=task_debug');
    expect(line).toContain('actor=codex');
  });

  it('emits via=none for a miss so we can tell "no pointer" from "wrong pointer"', async () => {
    process.env.MEMORIZE_DEBUG = '1';
    await resolveSessionContext(sandbox, { debugLabel: 'task-resume' });
    const debugLines = stderrCalls.filter((s) => s.includes('memorize-debug'));
    expect(debugLines).toHaveLength(1);
    expect(debugLines[0]).toContain('via=none');
    expect(debugLines[0]).toContain('session=-');
  });
});
