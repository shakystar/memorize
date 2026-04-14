import { Buffer } from 'node:buffer';

import { createTask } from '../../src/services/task-service.js';
import { loadStartContext } from '../../src/services/context-service.js';
import { setupProject } from '../../src/services/setup-service.js';
import { withFixture, readJsonFile } from './shared.js';

interface Expectations {
  expectedStartupContains: string[];
}

const fixtureName = process.argv[2] ?? 'mixed-context-project';

const result = await withFixture(fixtureName, async (ctx) => {
  const expectations = await readJsonFile<Expectations>(ctx.expectationsPath);
  const setupResult = await setupProject(ctx.projectPath);
  const projectId = setupResult.project.id;

  const task = await createTask({
    projectId,
    title: 'Benchmark startup payload',
    actor: 'benchmark',
  });
  const startup = await loadStartContext({
    projectId,
    taskId: task.id,
  });
  const serialized = JSON.stringify(startup);
  const startupContainsMatches = expectations.expectedStartupContains.filter((needle) =>
    serialized.includes(needle),
  ).length;

  return {
    benchmark: 'startup-basic',
    fixture: fixtureName,
    status:
      startupContainsMatches === expectations.expectedStartupContains.length
        ? 'pass'
        : 'fail',
    durationMs: 0,
    metrics: {
      projectRuleCount: startup.projectRules.length,
      startupPayloadBytes: Buffer.byteLength(serialized, 'utf8'),
      startupContainsMatches,
    },
    artifacts: {
      taskId: task.id,
    },
  };
});

console.log(JSON.stringify(result, null, 2));
