import type {
  ConsolidatedMemory,
  MemoryRetractedPayload,
  Observation,
  ProjectSyncState,
} from '../domain/entities.js';
import { getDb } from '../storage/db.js';
import { readJson } from '../storage/fs-utils.js';
import { getSyncFile } from '../storage/path-resolver.js';
import {
  getConsolidateWatermark,
  setConsolidateWatermark,
} from './consolidate-service.js';
import { deleteEmbedding } from './embeddings-store.js';
import { rebuildProjectProjection } from './projection-store.js';

/**
 * M3-b — physical reclamation ("garbage collection") of retracted memories
 * whose entire derivation unit is LOCAL-ONLY (un-pushed). SoT-050: an un-pushed
 * event is nobody else's, so hard-deleting it (a local log rewrite) is safe,
 * exactly like `git reset --hard` on an un-pushed commit. Retraction itself
 * (M3-a) is a tombstone that only HIDES a memory; this is the separate, opt-in
 * sweep that reclaims the bytes left behind.
 *
 * Scope (this bundle): un-pushed only. Reclaiming SHARED (already-pushed)
 * retracted memories needs a propagation/retention policy (a peer could still
 * re-sync a prematurely deleted row) and is deferred — those stay as tombstones.
 *
 * Revival-free by construction: a memory is only eligible when its
 * `memory.consolidated` AND every one of its source `observation.captured`
 * events are un-pushed. We delete the memory events plus the source observations
 * that no SURVIVING memory still references, so after the rebuild there is no
 * orphan observation left for the next consolidation boundary to re-derive the
 * memory from. A memory with any pushed source observation is left as a
 * tombstone (skipped), because we cannot delete the shared observation and an
 * un-shielded survivor could revive the memory on a watermark reset.
 */

export interface GcResult {
  /** Memory ids physically removed. */
  reclaimedMemories: string[];
  /** Total event rows deleted (memory.consolidated + memory.retracted + observations). */
  reclaimedEvents: number;
  /** Observation events deleted (subset of reclaimedEvents). */
  reclaimedObservations: number;
  /** Retracted memories left as tombstones because they are shared/not-fully-un-pushed. */
  skippedShared: number;
  /** True when nothing was mutated (report-only). */
  dryRun: boolean;
}

interface EventRowLite {
  seq: number;
  id: string;
  type: string;
  payload: string;
}

/**
 * Reclaim un-pushed retracted memories. Pure report when `dryRun` is set.
 * Deletes are wrapped in a single transaction; the projection is rebuilt after
 * so list/search/injection drop the reclaimed rows, and stale embeddings are
 * pruned (they are not rebuilt by the projector).
 */
export async function gcUnpushedRetracted(
  projectId: string,
  opts: { dryRun?: boolean } = {},
): Promise<GcResult> {
  const dryRun = opts.dryRun ?? false;
  const db = getDb(projectId);

  const rows = db
    .prepare('SELECT seq, id, type, payload FROM events ORDER BY seq')
    .all() as EventRowLite[];

  // The pushed high-water mark, as a seq. Everything with a greater seq is
  // local-only (un-pushed). No lastPushedEventId (never synced) => 0 => the
  // whole log is un-pushed.
  const state = await readJson<ProjectSyncState>(getSyncFile(projectId));
  let pushedSeq = 0;
  if (state?.lastPushedEventId) {
    const wm = db
      .prepare('SELECT seq FROM events WHERE id = ?')
      .get(state.lastPushedEventId) as { seq: number } | undefined;
    pushedSeq = wm?.seq ?? 0;
  }
  const isUnpushed = (seq: number): boolean => seq > pushedSeq;

  // Index the log: consolidated memories (+ their source obs), retract events,
  // and observation events — each with its seq for the un-pushed test.
  interface MemInfo {
    seq: number;
    eventId: string;
    sourceObs: string[];
  }
  const consolidatedByMem = new Map<string, MemInfo>();
  const retractEventsByMem = new Map<string, string[]>();
  const obsEventById = new Map<string, { seq: number; eventId: string }>();

  for (const row of rows) {
    if (row.type === 'memory.consolidated') {
      const m = JSON.parse(row.payload) as ConsolidatedMemory;
      consolidatedByMem.set(m.id, {
        seq: row.seq,
        eventId: row.id,
        sourceObs: m.sourceObservationIds ?? [],
      });
    } else if (row.type === 'memory.retracted') {
      const p = JSON.parse(row.payload) as MemoryRetractedPayload;
      const list = retractEventsByMem.get(p.retracts) ?? [];
      list.push(row.id);
      retractEventsByMem.set(p.retracts, list);
    } else if (row.type === 'observation.captured') {
      const o = JSON.parse(row.payload) as Observation;
      obsEventById.set(o.id, { seq: row.seq, eventId: row.id });
    }
  }

  // Eligible = retracted AND consolidated un-pushed AND every source observation
  // is absent-or-un-pushed (a pushed source obs can't be deleted, so skip to
  // stay revival-free).
  const eligible = new Set<string>();
  let skippedShared = 0;
  for (const memId of retractEventsByMem.keys()) {
    const info = consolidatedByMem.get(memId);
    if (!info) {
      // No consolidated event in this log (can't reason about sharedness) — leave it.
      skippedShared += 1;
      continue;
    }
    const unit_unpushed =
      isUnpushed(info.seq) &&
      info.sourceObs.every((obsId) => {
        const oe = obsEventById.get(obsId);
        return !oe || isUnpushed(oe.seq);
      });
    if (unit_unpushed) eligible.add(memId);
    else skippedShared += 1;
  }

  // Observations still needed by a SURVIVING memory (not being reclaimed) must
  // not be deleted — the survivor both keeps its provenance and shields the obs
  // from re-consolidation.
  const survivorObs = new Set<string>();
  for (const [memId, info] of consolidatedByMem) {
    if (!eligible.has(memId)) {
      for (const obsId of info.sourceObs) survivorObs.add(obsId);
    }
  }

  const deleteEventIds = new Set<string>();
  let reclaimedObservations = 0;
  for (const memId of eligible) {
    const info = consolidatedByMem.get(memId)!;
    deleteEventIds.add(info.eventId);
    for (const rid of retractEventsByMem.get(memId) ?? []) deleteEventIds.add(rid);
    for (const obsId of info.sourceObs) {
      if (survivorObs.has(obsId)) continue; // needed by a survivor
      const oe = obsEventById.get(obsId);
      if (!oe) continue; // no event to delete
      // Eligibility already guaranteed every source obs is absent-or-un-pushed.
      deleteEventIds.add(oe.eventId);
      reclaimedObservations += 1;
    }
  }

  const result: GcResult = {
    reclaimedMemories: [...eligible],
    reclaimedEvents: deleteEventIds.size,
    reclaimedObservations,
    skippedShared,
    dryRun,
  };

  if (dryRun || deleteEventIds.size === 0) return result;

  // Repair the consolidation watermark if it points at an observation we are
  // about to delete: otherwise readEventsSince(deletedId) falls back to
  // "everything" and re-consolidates the whole log. Move it to the greatest
  // SURVIVING event whose seq is <= the old watermark's seq (project.created,
  // seq 1, always survives, so a replacement always exists).
  const watermarkId = getConsolidateWatermark(projectId);
  let repairWatermarkTo: string | undefined;
  if (watermarkId && deleteEventIds.has(watermarkId)) {
    const wmSeq = rows.find((r) => r.id === watermarkId)?.seq ?? 0;
    let best: { seq: number; id: string } | undefined;
    for (const r of rows) {
      if (deleteEventIds.has(r.id)) continue;
      if (r.seq <= wmSeq && (!best || r.seq > best.seq)) best = { seq: r.seq, id: r.id };
    }
    repairWatermarkTo = best?.id;
  }

  const deleteStmt = db.prepare('DELETE FROM events WHERE id = ?');
  const applyDeletes = db.transaction(() => {
    for (const id of deleteEventIds) deleteStmt.run(id);
  });
  applyDeletes();

  if (repairWatermarkTo) setConsolidateWatermark(projectId, repairWatermarkTo);

  // Rebuild the projection (drops the reclaimed memory + observation rows and
  // repopulates FTS from scratch), then prune the now-orphan embedding vectors
  // (NOT rebuilt by the projector).
  await rebuildProjectProjection(projectId);
  for (const memId of eligible) deleteEmbedding(projectId, memId);

  return result;
}
