import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  ACTOR_SYSTEM,
  CURRENT_SCHEMA_VERSION,
  nowIso,
} from '../domain/common.js';
import { resolveActiveAccount } from '../domain/identity/account.js';
import { getPersonalStoreId } from '../domain/identity/personal-store.js';
import { createConsolidatedMemory, createWorkstream } from '../domain/entities.js';
import type { ConsolidatedMemory, Project } from '../domain/entities.js';
import {
  appendEvent,
  appendEvents,
  ensureProjectDirectories,
  type AppendEventInput,
} from '../storage/event-store.js';
import { withFileLock } from '../storage/file-lock.js';
import {
  getPersonalRoot,
  getProjectDbFile,
  getProjectRoot,
} from '../storage/path-resolver.js';
import type { ExtractedMemory } from './consolidate-service.js';
import { ensureEmbeddings } from './embeddings-service.js';
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
 *  - two ways in: (1) PRIMARY — the consolidation extractor classifies each
 *    item personal vs project and routes personal ones here automatically
 *    (consolidatePersonalMemories, called from consolidate()), so personal
 *    context is captured and managed by the same CLS logic as project memory;
 *    the classifier diverts personal items OUT of the project store, which is
 *    the structural fix for the #181 leak; (2) SECONDARY — the explicit
 *    `personal import` path for pre-existing external notes;
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
export async function ensurePersonalStore(
  accountId: string = resolveActiveAccount(),
): Promise<void> {
  const storeId = getPersonalStoreId(accountId);
  if (getProjectProjection(storeId)) return;

  const now = nowIso();
  const workstream = createWorkstream({
    projectId: storeId,
    title: 'default',
    summary: 'Personal memory',
  });
  const project: Project = {
    id: storeId,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    title: 'Personal memory',
    summary: 'Global personal memory (account-scoped, never synced)',
    goals: [],
    status: 'active',
    rootPath: getPersonalRoot(accountId),
    importedContextCount: 0,
    activeWorkstreamIds: [workstream.id],
    activeTaskIds: [],
    acceptedDecisionIds: [],
    ruleIds: [],
  };

  await ensureProjectDirectories(storeId);
  // Two separate appends (not a batch) so each payload keeps its own type —
  // appendEvents infers one shared payload type across the array, which a
  // Project + Workstream pair violates. Same reason createProject does this.
  await appendEvent({
    type: 'project.created',
    projectId: storeId,
    scopeType: 'project',
    scopeId: storeId,
    actor: ACTOR_SYSTEM,
    payload: project,
  });
  await appendEvent({
    type: 'workstream.created',
    projectId: storeId,
    scopeType: 'workstream',
    scopeId: workstream.id,
    actor: ACTOR_SYSTEM,
    payload: workstream,
  });
  await rebuildProjectProjection(storeId);
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
  accountId?: string;
}): Promise<MemoryImportResult> {
  const accountId = params.accountId ?? resolveActiveAccount();
  await ensurePersonalStore(accountId);
  return importMemories({
    projectId: getPersonalStoreId(accountId),
    actor: params.actor,
    source: params.source,
    itemsJson: params.itemsJson,
  });
}

/** The valid (non-superseded) memories in an account's personal store. */
export function listPersonalMemories(
  accountId: string = resolveActiveAccount(),
): ValidMemoryRow[] {
  return listValidMemories(getPersonalStoreId(accountId));
}

/**
 * Whether the personal store has been created yet. Used to read existing
 * personal memories for extractor dedup WITHOUT lazily creating an empty store
 * for every user who never captures personal memory (getDb would otherwise
 * materialize `~/.memorize/personal/` on first read).
 */
export function personalStoreExists(
  accountId: string = resolveActiveAccount(),
): boolean {
  return existsSync(getProjectDbFile(getPersonalStoreId(accountId)));
}

/**
 * Path A auto-capture: route the personal-classified items from a project's
 * consolidation boundary into the global personal store, applying the SAME CLS
 * long-term logic (consolidated memories, projection, embeddings, retrieval).
 * Called from consolidate() after extraction.
 *
 * sourceObservationIds carry the project-side provenance (the observations live
 * in the project store — opaque here, used only as dedup provenance). Personal
 * supersession is a follow-up, so supersedesMemoryId is intentionally not acted
 * on. Takes the personal store's own lock so concurrent consolidations from
 * DIFFERENT projects serialize their personal-store writes. Returns the count.
 */
export async function consolidatePersonalMemories(params: {
  items: ExtractedMemory[];
  actor: string;
  sessionId?: string;
  sourceObservationIds: string[];
  accountId?: string;
}): Promise<number> {
  if (params.items.length === 0) return 0;
  const accountId = params.accountId ?? resolveActiveAccount();
  const storeId = getPersonalStoreId(accountId);
  await ensurePersonalStore(accountId);
  return withFileLock(
    path.join(getProjectRoot(storeId), 'locks'),
    'consolidate',
    async () => {
      const inputs: AppendEventInput<ConsolidatedMemory>[] = params.items.map(
        (item) => {
          const memory = createConsolidatedMemory({
            projectId: storeId,
            kind: item.kind,
            text: item.text,
            salience: item.salience,
            ...(params.sessionId ? { sessionId: params.sessionId } : {}),
            sourceObservationIds: params.sourceObservationIds,
            ...(item.obsoleteWhen ? { obsoleteWhen: item.obsoleteWhen } : {}),
            ...(item.kindMisfit ? { kindMisfit: true } : {}),
            ...(item.kindMisfitReason
              ? { kindMisfitReason: item.kindMisfitReason }
              : {}),
            ...(item.supersedesNote
              ? { supersedesNote: item.supersedesNote }
              : {}),
            ...(item.tags ? { tags: item.tags } : {}),
          });
          return {
            type: 'memory.consolidated',
            projectId: storeId,
            scopeType: 'session',
            scopeId: params.sessionId ?? storeId,
            actor: params.actor,
            payload: memory,
          };
        },
      );
      await appendEvents(storeId, inputs);
      await rebuildProjectProjection(storeId, { reindexSearch: true });
      await ensureEmbeddings(storeId);
      return inputs.length;
    },
  );
}
