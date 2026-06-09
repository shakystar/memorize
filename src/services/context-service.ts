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
} from './memory-retrieval-service.js';
import { semanticMemoryScores } from './search-service.js';

/** Tight embed timeout at SessionStart — the network must never block boot. */
const SESSION_START_EMBED_TIMEOUT_MS = 5_000;
import {
  getMemoryIndex,
  getRule,
  getWorkstream,
  listOpenConflicts,
} from './projection-store.js';
import {
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

  return {
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
  };
}
