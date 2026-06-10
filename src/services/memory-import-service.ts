import path from 'node:path';

import { createConsolidatedMemory } from '../domain/entities.js';
import type { DomainEventPayload } from '../domain/events.js';
import {
  type AppendEventInput,
  appendEvents,
} from '../storage/event-store.js';
import { withFileLock } from '../storage/file-lock.js';
import { getProjectRoot } from '../storage/path-resolver.js';
import {
  ExtractionParseError,
  parseExtractedMemories,
} from './consolidate-service.js';
import { detectContradictions } from './contradiction-service.js';
import { ensureEmbeddings } from './embeddings-service.js';
import {
  listValidMemories,
  rebuildProjectProjection,
} from './projection-store.js';

/**
 * #69 — `memorize memory import`: the ingestion primitive behind agent-driven
 * absorption of pre-existing context (the agent's own harness memory,
 * CLAUDE.local.md / AGENTS.override.md content, user-named doc folders).
 * The AGENT does the reading and distillation — it has the read access, knows
 * its own memory location, and can honor the per-self/shared split (#61);
 * memorize only ingests the result. memorize itself never reads outside the
 * project tree here.
 *
 * Items use the SAME shape and sanitizers as the #57 extractor output, so
 * lifecycle-evidence fields ride along and malformed evidence degrades to
 * "absent" instead of failing the item.
 */

/**
 * Per-invocation cap. Far above MAX_MEMORIES_PER_BOUNDARY (12): a one-time
 * distillation of weeks of harness memory or an ADR folder legitimately
 * yields dozens of items; anything past this is probably an unreviewed dump.
 */
export const IMPORT_MAX_ITEMS = 100;

export interface MemoryImportResult {
  imported: number;
  /** Items dropped by the idempotency guard (kind+text already valid). */
  skippedDuplicates: number;
}

/** Same normalization the projection dedup uses for its text key. */
function textKey(kind: string, text: string): string {
  return `${kind}\n${text.trim().toLowerCase()}`;
}

export async function importMemories(params: {
  projectId: string;
  actor: string;
  /** Provenance label, e.g. `claude-memory`, `docs/adr` — stored on each memory. */
  source: string;
  /** Raw JSON text (typically stdin): an array of extractor-shaped items. */
  itemsJson: string;
  sessionId?: string;
}): Promise<MemoryImportResult> {
  const source = params.source.trim();
  if (!source) {
    throw new Error('memory import requires a non-empty --source label');
  }

  // Same defensive parser as the consolidation extractors: locates the JSON
  // array, drops malformed entries, sanitizes #57 evidence fields. Throws
  // ExtractionParseError when there is no parseable array at all.
  const items = parseExtractedMemories(params.itemsJson, {
    maxItems: IMPORT_MAX_ITEMS,
  });
  if (items.length === 0) {
    // Distinct from consolidation: an extractor may legitimately find
    // nothing in a window, but an agent invoking import with zero valid
    // items is a malformed call — fail loud, write nothing.
    throw new ExtractionParseError(
      'memory import: no valid memory items in input',
    );
  }

  // Serialize against boundary consolidation — both append memory events and
  // both read the valid set for their guards.
  return withFileLock(
    path.join(getProjectRoot(params.projectId), 'locks'),
    'consolidate',
    async () => {
      // Idempotency guard (#69): imported memories have EMPTY
      // sourceObservationIds, which the projection dedup never groups — a
      // re-run would silently duplicate. Skip items whose kind+normalized
      // text already exists as a valid memory instead.
      const existing = new Set(
        listValidMemories(params.projectId).map((row) =>
          textKey(row.memory.kind, row.memory.text),
        ),
      );

      const inputs: AppendEventInput<DomainEventPayload>[] = [];
      let skippedDuplicates = 0;
      for (const item of items) {
        if (existing.has(textKey(item.kind, item.text))) {
          skippedDuplicates += 1;
          continue;
        }
        existing.add(textKey(item.kind, item.text)); // in-batch dedup too
        const memory = createConsolidatedMemory({
          projectId: params.projectId,
          kind: item.kind,
          text: item.text,
          salience: item.salience,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          sourceObservationIds: [],
          ...(item.obsoleteWhen ? { obsoleteWhen: item.obsoleteWhen } : {}),
          ...(item.kindMisfit ? { kindMisfit: true } : {}),
          ...(item.kindMisfitReason
            ? { kindMisfitReason: item.kindMisfitReason }
            : {}),
          ...(item.supersedesNote
            ? { supersedesNote: item.supersedesNote }
            : {}),
          ...(item.tags ? { tags: item.tags } : {}),
          importSource: source,
        });
        inputs.push({
          type: 'memory.consolidated',
          projectId: params.projectId,
          scopeType: 'session',
          scopeId: params.sessionId ?? params.projectId,
          actor: params.actor,
          payload: memory,
        });
      }

      if (inputs.length > 0) {
        await appendEvents(params.projectId, inputs);
        // Same post-append duties as a consolidation boundary: make the new
        // memories searchable, embed them (best-effort), and let imported
        // decisions face contradiction detection against existing ones.
        await rebuildProjectProjection(params.projectId, {
          reindexSearch: true,
        });
        await ensureEmbeddings(params.projectId);
        await detectContradictions(params.projectId, {
          actor: params.actor,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        });
      }

      return { imported: inputs.length, skippedDuplicates };
    },
  );
}
