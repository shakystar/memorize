import { setupProject } from '../../src/services/setup-service.js';
import { getBoundProjectId } from '../../src/services/project-service.js';
import { loadStartContext } from '../../src/services/context-service.js';
import { readJson } from '../../src/storage/fs-utils.js';
import { withFixture } from './shared.js';

interface Expectations {
  expectedConflictCount: number;
}

const fixtureName = process.argv[2] ?? 'conflicted-context-project';

const result = await withFixture(fixtureName, async (ctx) => {
  const expectations = await readJson<Expectations>(ctx.expectationsPath);
  await setupProject(ctx.projectPath);
  const projectId = await getBoundProjectId(ctx.projectPath);
  if (!projectId) {
    return {
      benchmark: 'conflict-basic',
      fixture: fixtureName,
      status: 'fail' as const,
      durationMs: 0,
      metrics: {
        expectedConflictCount: expectations?.expectedConflictCount ?? 0,
        detectedConflictCount: 0,
      },
      artifacts: {},
    };
  }

  const startup = await loadStartContext({ projectId });
  const detectedConflictCount = startup.openConflicts.length;
  const expectedConflictCount = expectations?.expectedConflictCount ?? 0;

  return {
    benchmark: 'conflict-basic',
    fixture: fixtureName,
    status: detectedConflictCount >= expectedConflictCount ? 'pass' : 'fail',
    durationMs: 0,
    metrics: {
      expectedConflictCount,
      detectedConflictCount,
    },
    artifacts: {
      projectId,
    },
  };
});

console.log(JSON.stringify(result, null, 2));
