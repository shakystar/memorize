import { performance } from 'node:perf_hooks';

import { readProject } from '../../src/services/project-service.js';
import { loadStartContext } from '../../src/services/context-service.js';
import { setupProject } from '../../src/services/setup-service.js';
import { withFixture, readJsonFile } from './shared.js';

interface Expectations {
  fixtureName: string;
  expectedDiscoveryCount: number;
  expectedImportedRuleCount: number;
}

const fixtureName = process.argv[2] ?? 'mixed-context-project';

const result = await withFixture(fixtureName, async (ctx) => {
  const expectations = await readJsonFile<Expectations>(ctx.expectationsPath);
  const started = performance.now();
  const setupResult = await setupProject(ctx.projectPath);
  const durationMs = Math.round(performance.now() - started);

  const projectId = setupResult.project.id;
  const project = await readProject(projectId);
  const startup = await loadStartContext({ projectId });

  const importedRuleCount = startup?.projectRules.length ?? 0;

  return {
    benchmark: 'import-basic',
    fixture: fixtureName,
    status:
      importedRuleCount === expectations.expectedImportedRuleCount
        ? 'pass'
        : 'fail',
    durationMs,
    metrics: {
      discoveredFiles: expectations.expectedDiscoveryCount,
      importedRuleCount,
      importDurationMs: durationMs,
    },
    artifacts: {
      projectId,
      importedContextCount: String(project?.importedContextCount ?? 0),
    },
  };
});

console.log(JSON.stringify(result, null, 2));
