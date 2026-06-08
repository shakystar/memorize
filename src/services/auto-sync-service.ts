import { createFileSyncTransport } from '../adapters/sync-transport-file.js';
import type { ProjectSyncState } from '../domain/entities.js';
import type { SyncTransport } from '../domain/sync-transport.js';
import { readSyncState } from './project-service.js';
import { pullProject, pushProject } from './sync-service.js';

/**
 * P3-b — background auto-sync. Agents never call sync; boundary hooks invoke
 * these wrappers, which propagate events over the persisted transport. The
 * "no expensive per-turn work" rule (rc.0-4) is respected by wiring these to
 * BOUNDARIES only (PostCompact/SessionEnd push, SessionStart pull) — never
 * PostToolUse.
 *
 * Both helpers are watermark-gated (push/pull are incremental; a no-op is
 * cheap) and NEVER throw — a failure degrades to a stderr warn and a no-op,
 * exactly like consolidate's tryConsolidate. A project with no `syncTransport`
 * (the single-machine default) is a silent no-op with zero side effects.
 */

export interface AutoSyncResult {
  ran: boolean;
  reason?: 'not-configured' | 'reentrant' | 'error';
  pushed?: number;
  pulled?: number;
}

/**
 * Rebuild a live transport from persisted config so auto-sync doesn't need a
 * CLI `--remote-path`. Returns undefined when nothing is configured (or for a
 * not-yet-supported transport type, e.g. a future `http` relay).
 */
export function resolveTransport(
  state: ProjectSyncState,
): SyncTransport | undefined {
  const config = state.syncTransport;
  if (!config) return undefined;
  if (config.type === 'file') return createFileSyncTransport(config.location);
  return undefined;
}

function isConfigured(state: ProjectSyncState | undefined): state is ProjectSyncState {
  return Boolean(state?.syncEnabled && state?.remoteProjectId && state?.syncTransport);
}

/** Push at a boundary. No-op (silent) unless sync is fully configured. */
export async function autoPush(projectId: string): Promise<AutoSyncResult> {
  try {
    const state = await readSyncState(projectId);
    if (!isConfigured(state)) return { ran: false, reason: 'not-configured' };
    // Reentrancy guard: a push already in flight. (autoPull does NOT gate on
    // this — pull is idempotent, and gating risks wedging on a stale 'syncing'
    // left by a crashed push.)
    if (state.syncStatus === 'syncing') return { ran: false, reason: 'reentrant' };
    const transport = resolveTransport(state);
    if (!transport) return { ran: false, reason: 'not-configured' };
    const response = await pushProject(projectId, transport);
    return { ran: true, pushed: response.accepted.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARN: auto-push deferred (${message})\n`);
    return { ran: false, reason: 'error' };
  }
}

/** Pull at session start. No-op (silent) unless sync is fully configured. */
export async function autoPull(projectId: string): Promise<AutoSyncResult> {
  try {
    const state = await readSyncState(projectId);
    if (!isConfigured(state)) return { ran: false, reason: 'not-configured' };
    const transport = resolveTransport(state);
    if (!transport) return { ran: false, reason: 'not-configured' };
    const result = await pullProject(projectId, transport);
    return { ran: true, pulled: result.inserted };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARN: auto-pull deferred (${message})\n`);
    return { ran: false, reason: 'error' };
  }
}
