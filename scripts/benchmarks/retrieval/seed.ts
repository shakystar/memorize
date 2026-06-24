// scripts/benchmarks/retrieval/seed.ts
import { createConsolidatedMemory } from '../../../src/domain/entities.js';
import type { DomainEventPayload } from '../../../src/domain/events.js';
import { createProject } from '../../../src/services/project-service.js';
import { ensureEmbeddings } from '../../../src/services/embeddings-service.js';
import { rebuildProjectProjection } from '../../../src/services/projection-store.js';
import {
  type AppendEventInput,
  appendEvents,
} from '../../../src/storage/event-store.js';

import type { BenchQuestion } from './dataset.js';

export interface SeededQuestion {
  projectId: string;
  /** memory entityId -> originating session id, for scoring. */
  sessionIdByMemoryId: Map<string, string>;
}

export async function seedQuestion(
  q: BenchQuestion,
  opts: { rootPath: string; embed: boolean },
): Promise<SeededQuestion> {
  const project = await createProject({
    title: q.questionId,
    rootPath: opts.rootPath,
  });
  const projectId = project.id;

  const sessionIdByMemoryId = new Map<string, string>();
  const inputs: AppendEventInput<DomainEventPayload>[] = [];
  for (const session of q.sessions) {
    const memory = createConsolidatedMemory({
      projectId,
      kind: 'progress',
      text: session.text,
      salience: 5,
      sourceObservationIds: [],
    });
    sessionIdByMemoryId.set(memory.id, session.sessionId);
    inputs.push({
      type: 'memory.consolidated',
      projectId,
      scopeType: 'session',
      scopeId: projectId,
      actor: 'benchmark',
      payload: memory,
    });
  }

  await appendEvents(projectId, inputs);
  await rebuildProjectProjection(projectId, { reindexSearch: true });
  if (opts.embed) await ensureEmbeddings(projectId);

  return { projectId, sessionIdByMemoryId };
}
