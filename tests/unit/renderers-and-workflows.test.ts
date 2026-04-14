import { describe, expect, it } from 'vitest';

import type { StartupContextPayload } from '../../src/domain/entities.js';
import { renderClaudeStartupContext } from '../../src/adapters/claude/renderer.js';
import { renderCodexStartupContext } from '../../src/adapters/codex/renderer.js';
import { parseIntent } from '../../src/workflows/router.js';
import { resolveWorkflow } from '../../src/workflows/resolver.js';

const samplePayload: StartupContextPayload = {
  projectSummary: 'Memorize shared context system',
  projectRules: ['Keep startup payload small'],
  workstreamSummary: 'Default workstream',
  openConflicts: [],
  mustReadTopics: [],
};

describe('adapter renderers and workflows', () => {
  it('renders startup payloads for Claude and Codex', () => {
    const claudeOutput = renderClaudeStartupContext(samplePayload);
    const codexOutput = renderCodexStartupContext(samplePayload);

    expect(claudeOutput).toContain('Memorize context');
    expect(claudeOutput).toContain('Keep startup payload small');
    expect(codexOutput).toContain('Memorize startup context');
    expect(codexOutput).toContain('Default workstream');
  });

  it('routes sentence commands to workflow templates', () => {
    const createIntent = parseIntent('Create a task for auth cleanup');
    const resumeIntent = parseIntent('Resume the last blocked task');
    const summaryIntent = parseIntent('Summarize project status');

    expect(createIntent.intent).toBe('task.create');
    expect(resolveWorkflow(createIntent).name).toBe('create_task_with_context');

    expect(resumeIntent.intent).toBe('task.resume');
    expect(resolveWorkflow(resumeIntent).name).toBe('resume_task_with_context');

    expect(summaryIntent.intent).toBe('project.summary');
    expect(resolveWorkflow(summaryIntent).name).toBe('summarize_project_status');
  });
});
