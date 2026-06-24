import type Database from 'better-sqlite3';

import type {
  Checkpoint,
  Conflict,
  Decision,
  Handoff,
  MemoryIndex,
  Observation,
  Project,
  Rule,
  Session,
  Task,
  Workstream,
} from '../domain/entities.js';
import { buildMemoryIndex, reduceProjectState } from '../projections/projector.js';
import type { MemoryRecord, ProjectState } from '../projections/projector.js';
import { getDb } from '../storage/db.js';
import { readEvents, readEventsUpTo } from '../storage/event-store.js';
import { readJson, writeJson } from '../storage/fs-utils.js';
import { getTopicFile } from '../storage/path-resolver.js';

/**
 * The persisted shape of the memory index. buildMemoryIndex returns
 * `mustReadTopics[].path` as a `topic:<ruleId>` placeholder; we rewrite it to
 * the on-disk topic file path here so renderers / readers can open the file.
 * Topics themselves stay as `.md` content files (not a projection table) —
 * they are agent-readable content artifacts referenced by path, not query
 * projections.
 */
export type PersistedMemoryIndex = MemoryIndex;

// --- write side ------------------------------------------------------------

/** Searchable entity kinds indexed into `search_fts`. */
export type SearchKind =
  | 'task'
  | 'handoff'
  | 'decision'
  | 'checkpoint'
  | 'topic'
  | 'memory';

/**
 * Flatten an entity's human-text fields into a single FTS document. Skips
 * empty/undefined parts and collapses whitespace so blank fields never add
 * noise. The result is plain content (no FTS5 operators) — it is inserted as
 * a bound parameter, never interpolated.
 */
function searchText(parts: ReadonlyArray<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

const SINGLETON_TABLES = ['projects', 'memory_index'] as const;
const ENTITY_TABLES = [
  'workstreams',
  'tasks',
  'handoffs',
  'checkpoints',
  'decisions',
  'rules',
  'conflicts',
  'sessions',
  'observations',
  'memories',
] as const;

/**
 * Options for {@link rebuildProjectProjection}.
 */
export interface RebuildProjectProjectionOptions {
  /**
   * Whether to reindex the `search_fts` table as part of the rebuild.
   * Defaults to `true` (every existing call site is unchanged). Pass
   * `false` ONLY when the triggering event(s) cannot create or modify any
   * searchable entity (task / handoff / decision / checkpoint /
   * imported-topic rule) — e.g. pure session-state events like heartbeats.
   * Skipping the reindex leaves the existing `search_fts` rows untouched
   * (still valid, since no searchable entity changed) while the projection
   * TABLES are still fully rebuilt. Over-reindexing is correct (just
   * slower); skipping when a searchable entity changed is a BUG.
   */
  reindexSearch?: boolean;
}

/**
 * Historical duplicates: pre-idempotent-import re-runs minted multiple
 * imported rules for the same context file (same title, different ids).
 * The event log keeps them all (append-only); derived surfaces show one
 * topic per title — the freshest. Tie-break on id for determinism.
 */
function latestImportedRules(rules: Record<string, Rule>): Rule[] {
  const byTitle = new Map<string, Rule>();
  for (const rule of Object.values(rules)) {
    if (rule.source !== 'imported') continue;
    const prev = byTitle.get(rule.title);
    if (
      !prev ||
      rule.updatedAt > prev.updatedAt ||
      (rule.updatedAt === prev.updatedAt && rule.id > prev.id)
    ) {
      byTitle.set(rule.title, rule);
    }
  }
  return [...byTitle.values()];
}

/**
 * Recompute the full projection from the event log and replace every
 * projection table in a SINGLE transaction (replace-all semantics).
 * reduceProjectState is the single reduction authority; this function is only
 * the persistence sink. Topic `.md` files are written outside the transaction
 * (they are filesystem content, not table rows).
 */
export async function rebuildProjectProjection(
  projectId: string,
  opts: RebuildProjectProjectionOptions = {},
): Promise<void> {
  const reindexSearch = opts.reindexSearch ?? true;
  const state = reduceProjectState(await readEvents(projectId));
  if (!state.project) {
    throw new Error(`Project ${projectId} has no project.created event`);
  }
  const project = state.project;

  const importedRules = latestImportedRules(state.rules);

  const baseMemoryIndex = buildMemoryIndex(state);
  const memoryIndex: PersistedMemoryIndex = {
    ...baseMemoryIndex,
    mustReadTopics: importedRules.map((rule) => ({
      id: rule.id,
      title: rule.title,
      path: getTopicFile(projectId, rule.id),
    })),
  };

  // Topic content lives in `.md` files on disk (written below, outside the
  // tx). Read the previously-persisted topic content here, BEFORE opening the
  // synchronous rebuild transaction, so the FTS rows can be inserted inline.
  // A missing file (e.g. first rebuild after an import) is skipped — the rule
  // body is still indexed via the file write at the end of the prior rebuild.
  // When reindexSearch is false the FTS rows are left untouched, so the
  // (async, disk-reading) topic content load is skipped entirely.
  const topicSearchRows = reindexSearch
    ? (
        await Promise.all(
          importedRules.map(async (rule) => {
            const content = await readJson<{ title?: string; body?: string }>(
              getTopicFile(projectId, rule.id),
            );
            const text = searchText([
              rule.title,
              content?.title,
              content?.body ?? rule.body,
            ]);
            return text ? { entityId: rule.id, text } : undefined;
          }),
        )
      ).filter(
        (row): row is { entityId: string; text: string } => row !== undefined,
      )
    : [];

  const db = getDb(projectId);
  const writeAll = db.transaction(() => {
    // Retrieval reinforcement (`last_accessed_at`) lives ONLY in the
    // projection table — it is not an event, so a replace-all rebuild would
    // wipe it on every write. Carry it over across routine rebuilds; a true
    // from-scratch replay (fresh db, corruption recovery) resets it, which
    // is the accepted best-effort grade of reinforcement (decision ⑤ —
    // decay stays deterministic, reinforcement is a derived-layer
    // convenience, not part of the source of truth).
    // `injection_count` (#62 behavioral telemetry) rides the same carry-over:
    // projection-only, observe-only, reset by a from-scratch replay.
    const accessStateById = new Map<
      string,
      { lastAccessedAt: string | null; injectionCount: number }
    >(
      (
        db
          .prepare(
            'SELECT id, last_accessed_at, injection_count FROM memories ' +
              'WHERE last_accessed_at IS NOT NULL OR injection_count > 0',
          )
          .all() as Array<{
          id: string;
          last_accessed_at: string | null;
          injection_count: number;
        }>
      ).map((row) => [
        row.id,
        {
          lastAccessedAt: row.last_accessed_at,
          injectionCount: row.injection_count,
        },
      ]),
    );

    for (const table of [...SINGLETON_TABLES, ...ENTITY_TABLES]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    // search_fts is a replace-all sink too — wipe then repopulate within the
    // same tx (per-project db, so the unqualified DELETE is correct). When
    // reindexSearch is false we skip the wipe AND every indexEntity call, so
    // the existing FTS rows survive (still valid — no searchable entity
    // changed) while the projection tables above are still fully rebuilt.
    if (reindexSearch) {
      db.prepare('DELETE FROM search_fts').run();
    }
    const insertSearch = db.prepare(
      'INSERT INTO search_fts (entity_id, kind, text) VALUES (@entityId, @kind, @text)',
    );
    const indexEntity = (entityId: string, kind: SearchKind, text: string) => {
      if (reindexSearch && text) insertSearch.run({ entityId, kind, text });
    };

    db.prepare('INSERT INTO projects (id, data) VALUES (?, ?)').run(
      project.id,
      JSON.stringify(project),
    );
    db.prepare('INSERT INTO memory_index (id, data) VALUES (?, ?)').run(
      project.id,
      JSON.stringify(memoryIndex),
    );

    const insertWorkstream = db.prepare(
      'INSERT INTO workstreams (id, status, data) VALUES (@id, @status, @data)',
    );
    for (const workstream of Object.values(state.workstreams)) {
      insertWorkstream.run({
        id: workstream.id,
        status: workstream.status ?? null,
        data: JSON.stringify(workstream),
      });
    }

    const insertTask = db.prepare(
      `INSERT INTO tasks (id, status, workstream_id, created_at, updated_at, data)
       VALUES (@id, @status, @workstreamId, @createdAt, @updatedAt, @data)`,
    );
    for (const task of Object.values(state.tasks)) {
      insertTask.run({
        id: task.id,
        status: task.status ?? null,
        workstreamId: task.workstreamId ?? null,
        createdAt: task.createdAt ?? null,
        updatedAt: task.updatedAt ?? null,
        data: JSON.stringify(task),
      });
      indexEntity(
        task.id,
        'task',
        searchText([
          task.title,
          task.description,
          task.goal,
          ...(task.acceptanceCriteria ?? []),
          ...(task.openQuestions ?? []),
        ]),
      );
    }

    const insertHandoff = db.prepare(
      'INSERT INTO handoffs (id, data) VALUES (@id, @data)',
    );
    for (const handoff of Object.values(state.handoffs)) {
      insertHandoff.run({ id: handoff.id, data: JSON.stringify(handoff) });
      indexEntity(
        handoff.id,
        'handoff',
        searchText([
          handoff.summary,
          handoff.nextAction,
          ...(handoff.doneItems ?? []),
          ...(handoff.remainingItems ?? []),
          ...(handoff.warnings ?? []),
          ...(handoff.unresolvedQuestions ?? []),
        ]),
      );
    }

    const insertCheckpoint = db.prepare(
      'INSERT INTO checkpoints (id, data) VALUES (@id, @data)',
    );
    for (const checkpoint of Object.values(state.checkpoints)) {
      insertCheckpoint.run({
        id: checkpoint.id,
        data: JSON.stringify(checkpoint),
      });
      indexEntity(
        checkpoint.id,
        'checkpoint',
        searchText([
          checkpoint.summary,
          ...(checkpoint.taskUpdates ?? []),
          ...(checkpoint.projectUpdates ?? []),
          ...(checkpoint.deferredItems ?? []),
        ]),
      );
    }

    const insertDecision = db.prepare(
      'INSERT INTO decisions (id, status, data) VALUES (@id, @status, @data)',
    );
    for (const decision of Object.values(state.decisions)) {
      insertDecision.run({
        id: decision.id,
        status: decision.status ?? null,
        data: JSON.stringify(decision),
      });
      indexEntity(
        decision.id,
        'decision',
        searchText([decision.title, decision.decision, decision.rationale]),
      );
    }

    const insertRule = db.prepare(
      'INSERT INTO rules (id, source, data) VALUES (@id, @source, @data)',
    );
    for (const rule of Object.values(state.rules)) {
      insertRule.run({
        id: rule.id,
        source: rule.source ?? null,
        data: JSON.stringify(rule),
      });
    }

    const insertConflict = db.prepare(
      'INSERT INTO conflicts (id, status, data) VALUES (@id, @status, @data)',
    );
    for (const conflict of Object.values(state.conflicts)) {
      insertConflict.run({
        id: conflict.id,
        status: conflict.status ?? null,
        data: JSON.stringify(conflict),
      });
    }

    const insertSession = db.prepare(
      'INSERT INTO sessions (id, status, data) VALUES (@id, @status, @data)',
    );
    for (const session of Object.values(state.sessions)) {
      insertSession.run({
        id: session.id,
        status: session.status ?? null,
        data: JSON.stringify(session),
      });
    }

    const insertObservation = db.prepare(
      `INSERT INTO observations (id, session_id, signal, created_at, data)
       VALUES (@id, @sessionId, @signal, @createdAt, @data)`,
    );
    for (const observation of Object.values(state.observations)) {
      insertObservation.run({
        id: observation.id,
        sessionId: observation.sessionId ?? null,
        signal: observation.signal,
        createdAt: observation.createdAt,
        data: JSON.stringify(observation),
      });
    }

    const insertMemory = db.prepare(
      `INSERT INTO memories
         (id, kind, salience, created_at, invalid_at, superseded_by,
          deduped_by, last_accessed_at, injection_count, data)
       VALUES
         (@id, @kind, @salience, @createdAt, @invalidAt, @supersededBy,
          @dedupedBy, @lastAccessedAt, @injectionCount, @data)`,
    );
    for (const memory of Object.values(state.memories)) {
      const accessState = accessStateById.get(memory.id);
      insertMemory.run({
        id: memory.id,
        kind: memory.kind,
        salience: memory.salience,
        createdAt: memory.createdAt,
        invalidAt: memory.invalidAt ?? null,
        supersededBy: memory.supersededBy ?? null,
        dedupedBy: memory.dedupedBy ?? null,
        lastAccessedAt: accessState?.lastAccessedAt ?? null,
        injectionCount: accessState?.injectionCount ?? 0,
        data: JSON.stringify(memory),
      });
      // Superseded memories stay indexed — "what was true then" remains
      // findable; retrieval-time ranking is what filters to valid-only. Dedup
      // losers are NOT indexed: unlike a contradiction, a cross-machine
      // duplicate has no distinct "then" to recover, and keeping it out of FTS
      // means searchProject converges to the single winner too.
      if (!memory.dedupedBy) {
        indexEntity(memory.id, 'memory', searchText([memory.text]));
      }
    }

    for (const topic of topicSearchRows) {
      indexEntity(topic.entityId, 'topic', topic.text);
    }
  });
  writeAll();

  // Topic content files: imported rules become readable `.md` topics that the
  // memory index points at via mustReadTopics[].path. These are content
  // artifacts on disk, not a projection table.
  await Promise.all(
    Object.values(state.rules)
      .filter((rule) => rule.source === 'imported')
      .map((rule) =>
        writeJson(getTopicFile(projectId, rule.id), {
          title: rule.title,
          body: rule.body,
          sourceRuleId: rule.id,
        }),
      ),
  );
}

// --- read side -------------------------------------------------------------

function parse<T>(row: { data: string } | undefined): T | undefined {
  return row ? (JSON.parse(row.data) as T) : undefined;
}

function parseAll<T>(rows: Array<{ data: string }>): T[] {
  return rows.map((row) => JSON.parse(row.data) as T);
}

function db(projectId: string): Database.Database {
  return getDb(projectId);
}

export function getProjectProjection(projectId: string): Project | undefined {
  const row = db(projectId)
    .prepare('SELECT data FROM projects WHERE id = ?')
    .get(projectId) as { data: string } | undefined;
  return parse<Project>(row);
}

/**
 * State-as-of-revision: reduce the event log up to and including `upToEventId`.
 * Read-only — no projection tables are written. Reuses the single reduction
 * authority `reduceProjectState`, exactly like `rebuildProjectProjection`.
 */
export async function getProjectStateAtRevision(
  projectId: string,
  upToEventId: string,
): Promise<ProjectState> {
  return reduceProjectState(await readEventsUpTo(projectId, upToEventId));
}

export function getMemoryIndex(
  projectId: string,
): PersistedMemoryIndex | undefined {
  const row = db(projectId)
    .prepare('SELECT data FROM memory_index WHERE id = ?')
    .get(projectId) as { data: string } | undefined;
  return parse<PersistedMemoryIndex>(row);
}

export function getWorkstream(
  projectId: string,
  workstreamId: string,
): Workstream | undefined {
  const row = db(projectId)
    .prepare('SELECT data FROM workstreams WHERE id = ?')
    .get(workstreamId) as { data: string } | undefined;
  return parse<Workstream>(row);
}

export function getTask(projectId: string, taskId: string): Task | undefined {
  const row = db(projectId)
    .prepare('SELECT data FROM tasks WHERE id = ?')
    .get(taskId) as { data: string } | undefined;
  return parse<Task>(row);
}

export interface ListTasksFilters {
  status?: Task['status'];
  workstreamId?: string;
}

export function listTasks(
  projectId: string,
  filters: ListTasksFilters = {},
): Task[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  if (filters.workstreamId) {
    clauses.push('workstream_id = ?');
    params.push(filters.workstreamId);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = db(projectId)
    .prepare(`SELECT data FROM tasks${where} ORDER BY created_at ASC`)
    .all(...params) as Array<{ data: string }>;
  return parseAll<Task>(rows);
}

export function getHandoff(
  projectId: string,
  handoffId: string,
): Handoff | undefined {
  const row = db(projectId)
    .prepare('SELECT data FROM handoffs WHERE id = ?')
    .get(handoffId) as { data: string } | undefined;
  return parse<Handoff>(row);
}

export function getCheckpoint(
  projectId: string,
  checkpointId: string,
): Checkpoint | undefined {
  const row = db(projectId)
    .prepare('SELECT data FROM checkpoints WHERE id = ?')
    .get(checkpointId) as { data: string } | undefined;
  return parse<Checkpoint>(row);
}

export function getRule(projectId: string, ruleId: string): Rule | undefined {
  const row = db(projectId)
    .prepare('SELECT data FROM rules WHERE id = ?')
    .get(ruleId) as { data: string } | undefined;
  return parse<Rule>(row);
}

/**
 * Returns ALL imported rules for a project (all historical duplicates
 * included). The event log / rules table is append-only; this is the raw
 * view. Use mustReadTopics from getMemoryIndex() for the deduplicated view.
 */
export function listImportedRules(projectId: string): Rule[] {
  const rows = db(projectId)
    .prepare("SELECT data FROM rules WHERE source = 'imported'")
    .all() as Array<{ data: string }>;
  return parseAll<Rule>(rows);
}

export function getDecision(
  projectId: string,
  decisionId: string,
): Decision | undefined {
  const row = db(projectId)
    .prepare('SELECT data FROM decisions WHERE id = ?')
    .get(decisionId) as { data: string } | undefined;
  return parse<Decision>(row);
}

/**
 * List a project's decisions, newest first. By default returns only the live
 * (accepted) set — the same decisions `acceptedDecisionIds` carries; pass
 * `includeSuperseded` to also surface the preserved superseded ones. Pure
 * read of the projection, mirroring `listOpenConflicts`.
 */
export function listDecisions(
  projectId: string,
  opts: { includeSuperseded?: boolean } = {},
): Decision[] {
  const where = opts.includeSuperseded ? '' : " WHERE status = 'accepted'";
  const rows = db(projectId)
    .prepare(`SELECT data FROM decisions${where}`)
    .all() as Array<{ data: string }>;
  return parseAll<Decision>(rows).sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1,
  );
}

export function getConflict(
  projectId: string,
  conflictId: string,
): Conflict | undefined {
  const row = db(projectId)
    .prepare('SELECT data FROM conflicts WHERE id = ?')
    .get(conflictId) as { data: string } | undefined;
  return parse<Conflict>(row);
}

export function listOpenConflicts(projectId: string): Conflict[] {
  const rows = db(projectId)
    .prepare("SELECT data FROM conflicts WHERE status != 'resolved'")
    .all() as Array<{ data: string }>;
  return parseAll<Conflict>(rows);
}

export function listSessions(projectId: string): Session[] {
  const rows = db(projectId)
    .prepare('SELECT data FROM sessions')
    .all() as Array<{ data: string }>;
  return parseAll<Session>(rows);
}

export function getSession(
  projectId: string,
  sessionId: string,
): Session | undefined {
  const row = db(projectId)
    .prepare('SELECT data FROM sessions WHERE id = ?')
    .get(sessionId) as { data: string } | undefined;
  return parse<Session>(row);
}

// --- CLS two-layer memory (Phase 1) -----------------------------------------

/** A valid (non-superseded) memory plus its best-effort reinforcement stamp. */
export interface ValidMemoryRow {
  memory: MemoryRecord;
  /** Projection-only reinforcement signal — may reset on a full replay (⑤). */
  lastAccessedAt?: string;
}

/**
 * Read a single memory by id (valid or already-superseded), with its
 * best-effort reinforcement stamp. Mirrors the single-entity readers
 * (getTask/getRule) but carries `lastAccessedAt` like listValidMemories so
 * `memory show` can surface the reinforcement signal. Returns undefined when
 * no memory with that id exists in the project.
 */
export function getMemory(
  projectId: string,
  memoryId: string,
): ValidMemoryRow | undefined {
  const row = db(projectId)
    .prepare('SELECT data, last_accessed_at FROM memories WHERE id = ?')
    .get(memoryId) as { data: string; last_accessed_at: string | null } | undefined;
  if (!row) return undefined;
  return {
    memory: JSON.parse(row.data) as MemoryRecord,
    ...(row.last_accessed_at ? { lastAccessedAt: row.last_accessed_at } : {}),
  };
}

/** Memories whose validity window is still open, i.e. not superseded. */
export function listValidMemories(projectId: string): ValidMemoryRow[] {
  const rows = db(projectId)
    .prepare(
      'SELECT data, last_accessed_at FROM memories WHERE invalid_at IS NULL',
    )
    .all() as Array<{ data: string; last_accessed_at: string | null }>;
  return rows.map((row) => ({
    memory: JSON.parse(row.data) as MemoryRecord,
    ...(row.last_accessed_at ? { lastAccessedAt: row.last_accessed_at } : {}),
  }));
}

/**
 * Most recent observations (short-term tail), newest first. Old rows are
 * never deleted (append-only all the way down) — readers just take a recent
 * window.
 */
export function listRecentObservations(
  projectId: string,
  opts: { sessionId?: string; limit: number; sinceIso?: string },
): Observation[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.sessionId) {
    clauses.push('session_id = ?');
    params.push(opts.sessionId);
  }
  if (opts.sinceIso) {
    clauses.push('created_at >= ?');
    params.push(opts.sinceIso);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = db(projectId)
    .prepare(
      `SELECT data FROM observations${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, opts.limit) as Array<{ data: string }>;
  return parseAll<Observation>(rows);
}

/**
 * Retrieval reinforcement: stamp `last_accessed_at` on the memories that
 * were just injected into a session. This is a projection-level UPDATE on a
 * DERIVED table — the events log is untouched, so the append-only invariant
 * holds. Deliberately best-effort (decision ⑤): survives routine rebuilds
 * via the carry-over in rebuildProjectProjection, resets on a from-scratch
 * replay.
 */
export function touchMemoryAccess(
  projectId: string,
  memoryIds: string[],
  accessedAtIso: string,
): void {
  if (memoryIds.length === 0) return;
  const database = db(projectId);
  // #62 — startup injection is also an injection: bump the telemetry counter
  // in the same statement as the reinforcement stamp.
  const update = database.prepare(
    'UPDATE memories SET last_accessed_at = ?, ' +
      'injection_count = injection_count + 1 WHERE id = ?',
  );
  database.transaction(() => {
    for (const memoryId of memoryIds) {
      update.run(accessedAtIso, memoryId);
    }
  })();
}

/**
 * #62 behavioral telemetry — count a mid-session live-share injection of a
 * memory. UNLIKE touchMemoryAccess this deliberately does NOT stamp
 * `last_accessed_at`: reinforcement feeds retrieval ranking, and the #62
 * contract is observe-only (no behavior change to injection/ranking). Same
 * best-effort grade: projection-level UPDATE, carried over across routine
 * rebuilds, reset by a from-scratch replay.
 */
export function bumpMemoryInjections(
  projectId: string,
  memoryIds: string[],
): void {
  if (memoryIds.length === 0) return;
  const database = db(projectId);
  const update = database.prepare(
    'UPDATE memories SET injection_count = injection_count + 1 WHERE id = ?',
  );
  database.transaction(() => {
    for (const memoryId of memoryIds) {
      update.run(memoryId);
    }
  })();
}
