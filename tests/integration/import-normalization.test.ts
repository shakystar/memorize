import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAll } from '../../src/storage/db.js';
import { setupProject } from '../../src/services/setup-service.js';
import { getBoundProjectId } from '../../src/services/project-service.js';
import { loadStartContext } from '../../src/services/context-service.js';
import { getMemoryIndex } from '../../src/services/projection-store.js';

let sandbox: string;
let memorizeRoot: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-import-normalization-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  process.env.MEMORIZE_ROOT = memorizeRoot;
  await mkdir(join(sandbox, '.cursor', 'rules'), { recursive: true });
  await writeFile(
    join(sandbox, 'AGENTS.md'),
    '# Project guidance\nUse small commits and keep handoffs explicit.\n',
    'utf8',
  );
  await writeFile(
    join(sandbox, 'CLAUDE.md'),
    '# Claude guidance\nPrioritize architectural consistency.\n',
    'utf8',
  );
  await writeFile(
    join(sandbox, '.cursor', 'rules', 'coding.mdc'),
    'Always preserve project memory and update docs.',
    'utf8',
  );
});

afterEach(async () => {
  closeAll();
  await rm(sandbox, { recursive: true, force: true });
  delete process.env.MEMORIZE_ROOT;
});

describe('import normalization', () => {
  it('creates must-read topics and exposes them in startup context', async () => {
    await setupProject(sandbox);
    const projectId = await getBoundProjectId(sandbox);
    if (!projectId) throw new Error('Expected project id after setup.');

    const memoryIndex = getMemoryIndex(projectId);
    const startup = await loadStartContext({ projectId });

    expect(memoryIndex?.mustReadTopics.length).toBeGreaterThan(0);
    expect(startup.mustReadTopics.length).toBeGreaterThan(0);

    const firstTopic = startup.mustReadTopics[0];
    if (!firstTopic) {
      throw new Error('Expected at least one imported topic.');
    }
    const topicContent = await readFile(firstTopic.path, 'utf8');
    expect(topicContent).toContain('Imported');
  });
});
