import {
  ACTOR_SYSTEM,
  CURRENT_SCHEMA_VERSION,
  PERSONAL_STORE_ID,
  nowIso,
} from '../domain/common.js';
import { createWorkstream } from '../domain/entities.js';
import type { Project } from '../domain/entities.js';
import {
  appendEvent,
  ensureProjectDirectories,
} from '../storage/event-store.js';
import { getPersonalRoot } from '../storage/path-resolver.js';
import {
  importMemories,
  type MemoryImportResult,
} from './memory-import-service.js';
import {
  getProjectProjection,
  listValidMemories,
  rebuildProjectProjection,
  type ValidMemoryRow,
} from './projection-store.js';

/**
 * Global/personal memory store (Path A) — a host-level, account-scoped store
 * that holds the user's cross-project personal memory. It is intentionally a
 * SEPARATE pipeline from project memory, not a `scopeType` value:
 *
 *  - own event log + projection + consolidation under a reserved id
 *    (PERSONAL_STORE_ID), living in `~/.memorize/personal/` (getPersonalRoot),
 *    a sibling of `projects/` so it never appears in project enumeration;
 *  - the ONLY way in is the explicit personal-import path (decision §4-#1:
 *    separate input path, NOT extractor auto-classification — that would
 *    re-introduce the #181 personal-preference leak);
 *  - structurally excluded from sync/teams (assertNotPersonalStore in
 *    sync-service): personal memory is private and never leaves the host.
 *
 * Memory `kind` is currently inherited from the consolidation taxonomy
 * (decision | rationale | progress) because the store reuses the #69 import
 * primitive verbatim. A personal-specific vocabulary (e.g. preference, fact) is
 * a follow-up; it is intentionally out of scope for the store/import/isolation
 * slice and would mean parameterizing parseExtractedMemories' valid-kind set.
 */

/**
 * Idempotently bootstrap the personal store's event log. The projection layer
 * needs a `project.created` event to reduce from, so seed one (plus a default
 * workstream, mirroring createProject) under the fixed id on first use. No sync
 * state file is written and no path is bound — the store is global, not a cwd
 * project, and the missing sync state is itself part of the "never syncs"
 * guarantee. Cheap no-op once seeded.
 */
export async function ensurePersonalStore(): Promise<void> {
  if (getProjectProjection(PERSONAL_STORE_ID)) return;

  const now = nowIso();
  const workstream = createWorkstream({
    projectId: PERSONAL_STORE_ID,
    title: 'default',
    summary: 'Personal memory',
  });
  const project: Project = {
    id: PERSONAL_STORE_ID,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    title: 'Personal memory',
    summary: 'Global personal memory (account-scoped, never synced)',
    goals: [],
    status: 'active',
    rootPath: getPersonalRoot(),
    importedContextCount: 0,
    activeWorkstreamIds: [workstream.id],
    activeTaskIds: [],
    acceptedDecisionIds: [],
    ruleIds: [],
  };

  await ensureProjectDirectories(PERSONAL_STORE_ID);
  // Two separate appends (not a batch) so each payload keeps its own type —
  // appendEvents infers one shared payload type across the array, which a
  // Project + Workstream pair violates. Same reason createProject does this.
  await appendEvent({
    type: 'project.created',
    projectId: PERSONAL_STORE_ID,
    scopeType: 'project',
    scopeId: PERSONAL_STORE_ID,
    actor: ACTOR_SYSTEM,
    payload: project,
  });
  await appendEvent({
    type: 'workstream.created',
    projectId: PERSONAL_STORE_ID,
    scopeType: 'workstream',
    scopeId: workstream.id,
    actor: ACTOR_SYSTEM,
    payload: workstream,
  });
  await rebuildProjectProjection(PERSONAL_STORE_ID);
}

/**
 * Ingest agent-distilled personal memories into the global store. Reuses the
 * #69 import primitive (same extractor-shaped JSON, same idempotency guard)
 * against the personal store id. Crucially does NOT call autoPush — the personal
 * store is never propagated over sync.
 */
export async function importPersonalMemories(params: {
  actor: string;
  source: string;
  itemsJson: string;
}): Promise<MemoryImportResult> {
  await ensurePersonalStore();
  return importMemories({
    projectId: PERSONAL_STORE_ID,
    actor: params.actor,
    source: params.source,
    itemsJson: params.itemsJson,
  });
}

/** The valid (non-superseded) memories in the global personal store. */
export function listPersonalMemories(): ValidMemoryRow[] {
  return listValidMemories(PERSONAL_STORE_ID);
}
