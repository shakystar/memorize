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
