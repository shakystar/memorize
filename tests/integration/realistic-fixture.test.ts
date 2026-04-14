import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cloneFixtureToTmp } from '../../scripts/fixtures/clone-fixture-to-tmp.js';
import { setupProject } from '../../src/services/setup-service.js';
import { getBoundProjectId } from '../../src/services/project-service.js';
import { loadStartContext } from '../../src/services/context-service.js';

let cleanup: (() => Promise<void>) | undefined;

beforeEach(async () => {
  process.env.MEMORIZE_ROOT = join(
    await mkdtemp(join(tmpdir(), 'memorize-realistic-root-')),
    '.memorize-home',
  );
});

afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
  delete process.env.MEMORIZE_ROOT;
});

describe('realistic fixture', () => {
  it('imports and surfaces context for a realistic in-progress project', async () => {
    const cloned = await cloneFixtureToTmp('realistic-in-progress-project');
    cleanup = cloned.cleanup;

    await setupProject(cloned.projectPath);
    const projectId = await getBoundProjectId(cloned.projectPath);
    if (!projectId) throw new Error('Expected project id for realistic fixture');

    const startup = await loadStartContext({ projectId });
    expect(startup.projectRules.length).toBeGreaterThan(0);
    expect(startup.mustReadTopics.length).toBeGreaterThan(0);
    expect(startup.projectSummary.length).toBeGreaterThan(0);
  });
});
