import { buildMemoryIndex, reduceProjectState } from '../projections/projector.js';
import { readEvents } from '../storage/event-store.js';
import { writeJson } from '../storage/fs-utils.js';
import {
  getCheckpointFile,
  getConflictFile,
  getHandoffFile,
  getMemoryIndexFile,
  getProjectFile,
  getRuleFile,
  getTaskFile,
  getTopicFile,
  getWorkstreamFile,
} from '../storage/path-resolver.js';

export async function rebuildProjectProjection(projectId: string): Promise<void> {
  const state = reduceProjectState(await readEvents(projectId));
  if (!state.project) {
    throw new Error(`Project ${projectId} has no project.created event`);
  }

  const baseMemoryIndex = buildMemoryIndex(state);
  const mustReadTopics = Object.values(state.rules)
    .filter((rule) => rule.source === 'imported')
    .map((rule) => ({
      id: rule.id,
      title: rule.title,
      path: getTopicFile(projectId, rule.id),
    }));

  await writeJson(getProjectFile(projectId), state.project);
  await writeJson(getMemoryIndexFile(projectId), {
    ...baseMemoryIndex,
    mustReadTopics,
  });
  await Promise.all(
    Object.values(state.workstreams).map((workstream) =>
      writeJson(getWorkstreamFile(projectId, workstream.id), workstream),
    ),
  );
  await Promise.all(
    Object.values(state.tasks).map((task) =>
      writeJson(getTaskFile(projectId, task.id), task),
    ),
  );
  await Promise.all(
    Object.values(state.rules).map((rule) =>
      writeJson(getRuleFile(projectId, rule.id), rule),
    ),
  );
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
  await Promise.all(
    Object.values(state.checkpoints).map((checkpoint) =>
      writeJson(getCheckpointFile(projectId, checkpoint.id), checkpoint),
    ),
  );
  await Promise.all(
    Object.values(state.handoffs).map((handoff) =>
      writeJson(getHandoffFile(projectId, handoff.id), handoff),
    ),
  );
  await Promise.all(
    Object.values(state.conflicts).map((conflict) =>
      writeJson(getConflictFile(projectId, conflict.id), conflict),
    ),
  );
}
