import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderClaudeStartupContext } from '../../src/adapters/claude/renderer.js';
import { renderCodexStartupContext } from '../../src/adapters/codex/renderer.js';
import { getBoundProjectId } from '../../src/services/project-service.js';
import { createTask } from '../../src/services/task-service.js';
import { loadStartContext } from '../../src/services/context-service.js';
import { setupProject } from '../../src/services/setup-service.js';
import { cloneFixtureToTmp } from '../../scripts/fixtures/clone-fixture-to-tmp.js';

let sandboxCleanup: (() => Promise<void>) | undefined;
let projectPath: string;

beforeEach(async () => {
  const cloned = await cloneFixtureToTmp('mixed-context-project');
  sandboxCleanup = cloned.cleanup;
  projectPath = cloned.projectPath;
  process.env.MEMORIZE_ROOT = cloned.memorizeRoot;
});

afterEach(async () => {
  if (sandboxCleanup) {
    await sandboxCleanup();
  }
  delete process.env.MEMORIZE_ROOT;
});

describe('golden outputs', () => {
  it('keeps startup payload and renderer outputs stable for mixed-context import', async () => {
    await setupProject(projectPath);
    const projectId = await getBoundProjectId(projectPath);
    if (!projectId) throw new Error('Expected a bound project id.');

    const task = await createTask({
      projectId,
      title: 'Golden startup payload task',
      actor: 'test',
    });
    const startup = await loadStartContext({
      projectId,
      taskId: task.id,
    });

    expect(startup.projectRules).toEqual([
      'Imported AGENTS.md: # Project guidance\n\nUse small commits and keep handoffs explicit.',
      'Imported CLAUDE.md: # Claude guidance\n\nPrioritize architectural consistency.',
      'Imported coding.mdc: Always preserve project memory and update docs.',
    ]);
    expect(renderClaudeStartupContext(startup)).toContain(
      'Prioritize architectural consistency.',
    );
    expect(renderCodexStartupContext(startup)).toContain(
      'Always preserve project memory and update docs.',
    );
  });
});
