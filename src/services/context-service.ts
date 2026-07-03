import type {
  OtherActiveTask,
  Rule,
  StartupContextPayload,
} from '../domain/entities.js';
import {
  getEmbedder,
  resolveEmbeddingsConfig,
} from './embeddings-service.js';
import { freshnessLabel } from './freshness.js';
import {
  reinforceInjectedMemories,
  retrieveMemoryContext,
  retrieveSegments,
} from './memory-retrieval-service.js';
import { semanticMemoryScores } from './search-service.js';

/** Tight embed timeout at SessionStart — the network must never block boot. */
const SESSION_START_EMBED_TIMEOUT_MS = 5_000;

/**
 * Path A: small fixed slot for the global personal-memory channel at startup.
 * Personal memory is cross-project and few, so a salience-ranked top-N is the
 * right shape — no task-relevance ranking (preferences aren't task-specific)
 * and no embed call (SessionStart must stay fast). Deliberately small so it can
 * never crowd out the project memory channel.
 */
const PERSONAL_MEMORY_SLOT = 5;

/**
 * W3: own char budget for the workspace shared channel — deliberately SEPARATE
 * from the private pool's MEMORY_POOL_BUDGET_CHARS (memory-retrieval-service)
 * so shared memory can never draw from or crowd the private channels (SoT-040
 * budget-limited injection). A char cap rather than a count slot like
 * PERSONAL_MEMORY_SLOT: a workspace union can carry many writers' memories, so
 * the bound must be on injected volume, not entry count.
 */
const SHARED_MEMORY_BUDGET_CHARS = 2000;
/** Per-entry overhead, mirroring the private pool's budget math. */
const SHARED_MEMORY_ENTRY_CHARS_OVERHEAD = 24;

/**
 * SoT-041 inbox READ-side guard — independent of the write-side guard
 * (`assertContentLength` in task-request-service, which only binds an honest
 * local writer). A synced-in `task.requested` event from a malicious or buggy
 * member project can still flood the union log or carry oversized title/goal
 * text, so this consumption boundary caps volume and truncates text before it
 * ever reaches a renderer. `listTaskRequests` already orders oldest-first
 * (created_at ASC), so a plain slice keeps the OLDEST pending requests — the
 * most escalated — rather than an arbitrary/newest subset.
 */
const INBOUND_TASK_REQUEST_CAP = 5;
const INBOUND_TASK_REQUEST_TITLE_MAX = 200;
const INBOUND_TASK_REQUEST_GOAL_MAX = 500;

function truncateInboxField(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Top personal memories for the startup channel. Best-effort and never-throw:
 * a missing/unreadable personal store yields []. Guarded by personalStoreExists
 * so a user who has never captured personal memory does not get an empty store
 * materialized at every SessionStart.
 */
function loadPersonalMemoryChannel(): StartupContextPayload['personalMemories'] {
  if (!personalStoreExists()) return undefined;
  try {
    const rows = listPersonalMemories()
      .sort((a, b) => {
        if (b.memory.salience !== a.memory.salience) {
          return b.memory.salience - a.memory.salience;
        }
        return a.memory.createdAt < b.memory.createdAt ? 1 : -1;
      })
      .slice(0, PERSONAL_MEMORY_SLOT);
    if (rows.length === 0) return undefined;
    return rows.map(({ memory }) => ({
      id: memory.id,
      kind: memory.kind,
      text: memory.text,
      salience: memory.salience,
    }));
  } catch {
    return undefined;
  }
}

/**
 * W3: top shared memories for the startup channel — every OTHER member's
 * memories from the union lane, ranked salience-then-recency, filled under the
 * channel's own char budget, then grouped by writer so the renderer can label
 * lanes by adjacency. Gated on the workspace binding (cheap local sync-state
 * read, no network) so plain `proj_`/unsynced projects never pay a union read.
 * Self-lane rows are excluded — they already flow through the private pool.
 * Best-effort and never-throw, like the personal channel.
 */
async function loadSharedMemoryChannel(
  projectId: string,
): Promise<StartupContextPayload['sharedMemories']> {
  try {
    const binding = await getWorkspaceBinding(projectId);
    if (!binding) return undefined;

    const ranked = listValidMemories(projectId, 'union')
      .filter((row) => Boolean(row.memory.sourceProjectId))
      .sort((a, b) => {
        if (b.memory.salience !== a.memory.salience) {
          return b.memory.salience - a.memory.salience;
        }
        return a.memory.createdAt < b.memory.createdAt ? 1 : -1;
      });

    const picked: typeof ranked = [];
    let spent = 0;
    for (const row of ranked) {
      const chars = row.memory.text.length + SHARED_MEMORY_ENTRY_CHARS_OVERHEAD;
      if (spent + chars > SHARED_MEMORY_BUDGET_CHARS) continue;
      spent += chars;
      picked.push(row);
    }
    if (picked.length === 0) return undefined;

    // Group by writer lane (stable label order), best-first within a lane.
    picked.sort((a, b) => {
      const writerA = a.memory.sourceProjectId!;
      const writerB = b.memory.sourceProjectId!;
      if (writerA !== writerB) return writerA < writerB ? -1 : 1;
      if (b.memory.salience !== a.memory.salience) {
        return b.memory.salience - a.memory.salience;
      }
      return a.memory.createdAt < b.memory.createdAt ? 1 : -1;
    });
    return picked.map(({ memory }) => ({
      id: memory.id,
      kind: memory.kind,
      text: memory.text,
      salience: memory.salience,
      writer: memory.sourceProjectId!,
    }));
  } catch {
    return undefined;
  }
}
import {
  getMemoryIndex,
  getRule,
  getWorkstream,
  listOpenConflicts,
  listTaskRequests,
  listValidMemories,
} from './projection-store.js';
import { getWorkspaceBinding } from './workspace-service.js';
import {
  listPersonalMemories,
  personalStoreExists,
} from './personal-store-service.js';
import {
  ensureProjectGenesis,
  readDefaultWorkstreamForProject,
  readProject,
} from './project-service.js';
import { readActiveSessions } from './session-service.js';
import { readCheckpoint, readHandoff, readTask } from './task-service.js';

function readProjectRules(projectId: string, ruleIds: string[]): Rule[] {
  return ruleIds
    .map((ruleId) => getRule(projectId, ruleId))
    .filter((rule): rule is Rule => Boolean(rule));
}

async function buildOtherActiveTasks(params: {
  projectId: string;
  sessions: Awaited<ReturnType<typeof readActiveSessions>>;
  selfTaskId?: string;
  selfSessionId?: string;
}): Promise<OtherActiveTask[]> {
  const otherSessions = params.sessions.filter((session) => {
    if (params.selfSessionId && session.id === params.selfSessionId) return false;
    if (!session.taskId) return false;
    if (params.selfTaskId && session.taskId === params.selfTaskId) return false;
    return true;
  });
  if (otherSessions.length === 0) return [];

  const tasks = await Promise.all(
    otherSessions.map(async (session) => {
      const task = await readTask(params.projectId, session.taskId!);
      if (!task) return undefined;
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        assignment: {
          sessionId: session.id,
          actor: session.actor,
          lastSeenAt: session.lastSeenAt,
          freshness: freshnessLabel(session.lastSeenAt),
        },
      } satisfies OtherActiveTask;
    }),
  );
  return tasks.filter((entry): entry is OtherActiveTask => Boolean(entry));
}

export async function loadStartContext(params: {
  projectId: string;
  workstreamId?: string;
  taskId?: string;
  selfSessionId?: string;
}): Promise<StartupContextPayload> {
  // Self-heal: a store whose event log has events but no `project.created`
  // genesis (migration / capture-without-genesis) makes readProject throw
  // "not found" and blocks startup. Backfill the genesis at SessionStart so the
  // store's accumulated observations/memories become readable (SoT-021: the
  // local project.created is the always-present local identity).
  await ensureProjectGenesis(params.projectId);
  const project = await readProject(params.projectId);
  if (!project) {
    throw new Error(`Project ${params.projectId} not found`);
  }

  const memoryIndex = getMemoryIndex(params.projectId);

  const workstream = params.workstreamId
    ? getWorkstream(params.projectId, params.workstreamId)
    : await readDefaultWorkstreamForProject(project);

  let task = params.taskId
    ? await readTask(params.projectId, params.taskId)
    : undefined;

  // Compute claimed-by-others up-front so the auto-picker can avoid
  // duplicate work. The rc.2 dogfood surfaced that without this, four
  // sessions started 1.5min apart all received the same first task.
  const activeSessions = await readActiveSessions(params.projectId);
  const claimedTaskIds = new Set(
    activeSessions
      .filter((s) =>
        params.selfSessionId ? s.id !== params.selfSessionId : true,
      )
      .map((s) => s.taskId)
      .filter((id): id is string => Boolean(id)),
  );

  if (!task) {
    const candidateTasks = (
      await Promise.all(
        project.activeTaskIds.map((taskId) =>
          readTask(params.projectId, taskId),
        ),
      )
    ).filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

    const isUnclaimed = (t: typeof candidateTasks[number]): boolean =>
      !claimedTaskIds.has(t.id);
    const findUnclaimedWithStatus = (status: string) =>
      candidateTasks.find((c) => isUnclaimed(c) && c.status === status);

    // Tier 1 — unclaimed, by status preference. Tier 2 — any unclaimed
    // regardless of status. Final tier — original deterministic picker
    // (claimed-but-prefer-in-progress) so we always return something
    // when at least one candidate exists.
    task =
      findUnclaimedWithStatus('in_progress') ??
      findUnclaimedWithStatus('handoff_ready') ??
      candidateTasks.find(isUnclaimed) ??
      candidateTasks.find((c) => c.status === 'in_progress') ??
      candidateTasks.find((c) => c.status === 'handoff_ready') ??
      candidateTasks[0];
  }
  const latestHandoff =
    task?.latestHandoffId
      ? await readHandoff(params.projectId, task.latestHandoffId)
      : undefined;
  const latestCheckpoint =
    task?.latestCheckpointId
      ? await readCheckpoint(params.projectId, task.latestCheckpointId)
      : undefined;
  const rules = readProjectRules(params.projectId, project.ruleIds);

  // SoT-041 inbox: surface pending inbound delegation at the same boundary
  // that surfaces everything else — no polling, just the projection read.
  // Capped + truncated at this read boundary (see INBOUND_TASK_REQUEST_CAP
  // above) so a foreign member project can never flood or bloat the startup
  // payload regardless of what the write-side guard let through.
  const allInboundTaskRequests = await listTaskRequests(params.projectId, {
    direction: 'inbound',
    status: 'pending',
  });
  const inboundTaskRequestsOmitted = Math.max(
    0,
    allInboundTaskRequests.length - INBOUND_TASK_REQUEST_CAP,
  );
  const inboundTaskRequests = allInboundTaskRequests
    .slice(0, INBOUND_TASK_REQUEST_CAP)
    .map((request) => ({
      id: request.id,
      fromProjectId: request.projectId,
      title: truncateInboxField(request.title, INBOUND_TASK_REQUEST_TITLE_MAX),
      goal: truncateInboxField(request.goal, INBOUND_TASK_REQUEST_GOAL_MAX),
      createdAt: request.createdAt,
    }));

  const otherActiveTasks = await buildOtherActiveTasks({
    projectId: params.projectId,
    sessions: activeSessions,
    ...(task?.id ? { selfTaskId: task.id } : {}),
    ...(params.selfSessionId ? { selfSessionId: params.selfSessionId } : {}),
  });

  // P3-c — semantic relevance boost: embed the task title and score memories
  // by cosine similarity (graded boost in retrieveMemoryContext). Best-effort
  // with a tight timeout so SessionStart never blocks on the network; degrades
  // to FTS-only when no embeddings endpoint is configured or the embed times
  // out. semanticMemoryScores is itself never-throw, but guard defensively.
  let semanticScores: Map<string, number> | undefined;
  if (task?.title) {
    try {
      const config = resolveEmbeddingsConfig();
      if (config) {
        const scores = await semanticMemoryScores(
          params.projectId,
          task.title,
          getEmbedder({ ...config, timeoutMs: SESSION_START_EMBED_TIMEOUT_MS }),
        );
        if (scores.size > 0) semanticScores = scores;
      }
    } catch {
      // best-effort — fall back to FTS relevance only.
    }
  }

  // CLS two-layer retrieval: rank consolidated memories + the previous
  // session's observation tail in one pool, then stamp the injected
  // memories as accessed (reinforcement — projection-only, best-effort ⑤).
  const retrieved = retrieveMemoryContext(params.projectId, {
    ...(task?.title ? { taskTitle: task.title } : {}),
    ...(semanticScores ? { semanticScores } : {}),
  });
  reinforceInjectedMemories(params.projectId, retrieved.memories);

  // Raw-detail channel (v10): verbatim transcript segments for the task, surfaced
  // ALONGSIDE consolidated memories with their own budget. Best-effort; empty
  // without a task title, segments, or embedder. Reuses the session-start embedder
  // + tight timeout so SessionStart never blocks on the network.
  let rawSegments: Array<{ id: string; text: string }> = [];
  if (task?.title) {
    try {
      const config = resolveEmbeddingsConfig();
      const embedder = config
        ? getEmbedder({ ...config, timeoutMs: SESSION_START_EMBED_TIMEOUT_MS })
        : undefined;
      rawSegments = await retrieveSegments(params.projectId, {
        taskTitle: task.title,
        ...(embedder ? { embedder } : {}),
      });
    } catch {
      // best-effort — segments are augmentative.
    }
  }

  // Path A: global personal memory in its own channel, alongside (never mixed
  // into) the project memory pool. Best-effort; absent when no personal store.
  const personalMemories = loadPersonalMemoryChannel();

  // W3: the workspace shared channel — other members' memories from the union
  // lane, labelled by writer, under their own budget pool. Best-effort; absent
  // when the project is not workspace-bound.
  const sharedMemories = await loadSharedMemoryChannel(params.projectId);

  return {
    ...(rawSegments.length > 0 ? { rawSegments } : {}),
    ...(retrieved.memories.length > 0
      ? {
          consolidatedMemories: retrieved.memories.map(({ memory }) => ({
            id: memory.id,
            kind: memory.kind,
            text: memory.text,
            salience: memory.salience,
            createdAt: memory.createdAt,
          })),
        }
      : {}),
    ...(personalMemories ? { personalMemories } : {}),
    ...(sharedMemories ? { sharedMemories } : {}),
    ...(retrieved.observations.length > 0
      ? {
          recentObservations: retrieved.observations.map((observation) => ({
            signal: observation.signal,
            ...(observation.toolName ? { toolName: observation.toolName } : {}),
            ...(observation.summary ? { summary: observation.summary } : {}),
            createdAt: observation.createdAt,
          })),
        }
      : {}),
    projectSummary: memoryIndex?.shortSummary ?? project.summary,
    projectRules: rules.map((rule) => `${rule.title}: ${rule.body}`),
    ...(workstream?.summary
      ? { workstreamSummary: workstream.summary }
      : {}),
    ...(task ? { task } : {}),
    ...(latestHandoff ? { latestHandoff } : {}),
    ...(latestCheckpoint ? { latestCheckpoint } : {}),
    openConflicts: listOpenConflicts(params.projectId),
    mustReadTopics: memoryIndex?.mustReadTopics ?? [],
    ...(otherActiveTasks.length > 0 ? { otherActiveTasks } : {}),
    ...(inboundTaskRequests.length > 0 ? { inboundTaskRequests } : {}),
    ...(inboundTaskRequestsOmitted > 0 ? { inboundTaskRequestsOmitted } : {}),
  };
}
