import { createTask, createHandoff } from '../../src/services/task-service.js';
import { setupProject } from '../../src/services/setup-service.js';
import { getBoundProjectId } from '../../src/services/project-service.js';
import { withFixture } from './shared.js';

const fixtureName = process.argv[2] ?? 'realistic-in-progress-project';

const result = await withFixture(fixtureName, async (ctx) => {
  await setupProject(ctx.projectPath);
  const projectId = await getBoundProjectId(ctx.projectPath);
  if (!projectId) {
    return {
      benchmark: 'handoff-basic',
      fixture: fixtureName,
      status: 'fail' as const,
      durationMs: 0,
      metrics: {
        doneItemsCount: 0,
        remainingItemsCount: 0,
        hasNextAction: false,
      },
      artifacts: {},
    };
  }

  const task = await createTask({
    projectId,
    title: 'Benchmark handoff task',
    actor: 'benchmark',
  });
  const handoff = await createHandoff({
    projectId,
    taskId: task.id,
    fromActor: 'claude',
    toActor: 'codex',
    summary: 'Benchmark handoff summary',
    nextAction: 'Continue from benchmark handoff',
    doneItems: ['imported context reviewed'],
    remainingItems: ['finish implementation'],
  });

  return {
    benchmark: 'handoff-basic',
    fixture: fixtureName,
    status: handoff.nextAction.length > 0 ? 'pass' : 'fail',
    durationMs: 0,
    metrics: {
      doneItemsCount: handoff.doneItems.length,
      remainingItemsCount: handoff.remainingItems.length,
      hasNextAction: handoff.nextAction.length > 0,
    },
    artifacts: {
      handoffId: handoff.id,
      taskId: task.id,
    },
  };
});

console.log(JSON.stringify(result, null, 2));
