import { describe, expect, it } from 'vitest';

import type {
  Conflict,
  Handoff,
  StartupContextPayload,
  Task,
} from '../../src/domain/entities.js';
import { renderClaudeStartupContext } from '../../src/adapters/claude/renderer.js';
import { renderCodexStartupContext } from '../../src/adapters/codex/renderer.js';

const samplePayload: StartupContextPayload = {
  projectSummary: 'Memorize shared context system',
  projectRules: ['Keep startup payload small'],
  workstreamSummary: 'Default workstream',
  openConflicts: [],
  mustReadTopics: [],
};

const ISO = '2026-04-20T00:00:00.000Z';

const richTask: Task = {
  id: 'task_abc_1',
  schemaVersion: '0.1.0',
  createdAt: ISO,
  updatedAt: ISO,
  projectId: 'proj_abc_1',
  title: 'Wire renderer fields',
  description: 'Render acceptance criteria and open questions in adapters.',
  status: 'in_progress',
  priority: 'high',
  ownerType: 'agent',
  goal: 'Propagate full task context to agents',
  acceptanceCriteria: ['Claude shows AC', 'Codex shows AC'],
  dependsOn: [],
  contextRefIds: [],
  decisionRefIds: [],
  ruleRefIds: [],
  openQuestions: ['truncate threshold?'],
  riskNotes: ['long descriptions may bloat context'],
};

const richHandoff: Handoff = {
  id: 'handoff_abc_1',
  schemaVersion: '0.1.0',
  createdAt: ISO,
  updatedAt: ISO,
  projectId: 'proj_abc_1',
  taskId: 'task_abc_1',
  fromActor: 'claude',
  toActor: 'codex',
  summary: 'Wiring underway',
  nextAction: 'finish renderer polish',
  doneItems: [],
  remainingItems: [],
  requiredContextRefs: [],
  warnings: [],
  unresolvedQuestions: ['should we truncate descriptions?'],
  confidence: 'medium',
};

const sampleConflict: Conflict = {
  id: 'conflict_abc_1',
  schemaVersion: '0.1.0',
  createdAt: ISO,
  updatedAt: ISO,
  projectId: 'proj_abc_1',
  scopeType: 'task',
  scopeId: 'task_abc_1',
  fieldPath: 'status',
  leftVersion: 'in_progress',
  rightVersion: 'blocked',
  conflictType: 'state',
  status: 'detected',
};

const richPayload: StartupContextPayload = {
  projectSummary: 'Memorize shared context system',
  projectRules: ['Keep startup payload small'],
  workstreamSummary: 'Default workstream',
  task: richTask,
  latestHandoff: richHandoff,
  openConflicts: [sampleConflict],
  mustReadTopics: [
    { id: 'rule_abc_1', title: 'Runtime guardrails', path: '/rules/guardrails' },
  ],
};

describe('adapter renderers', () => {
  it('renders startup payloads for Claude and Codex', () => {
    const claudeOutput = renderClaudeStartupContext(samplePayload);
    const codexOutput = renderCodexStartupContext(samplePayload);

    expect(claudeOutput).toContain('Memorize context');
    expect(claudeOutput).toContain('Keep startup payload small');
    expect(codexOutput).toContain('Memorize startup context');
    expect(codexOutput).toContain('Default workstream');
  });

  it('propagates task, handoff, conflict, and topic details to Claude', () => {
    const output = renderClaudeStartupContext(richPayload);

    expect(output).toContain('Priority: high');
    expect(output).toContain(
      'Description: Render acceptance criteria and open questions in adapters.',
    );
    expect(output).toContain('Acceptance criteria:');
    expect(output).toContain('- Claude shows AC');
    expect(output).toContain('Open questions:');
    expect(output).toContain('- truncate threshold?');
    expect(output).toContain('Risk notes:');
    expect(output).toContain('- long descriptions may bloat context');
    expect(output).toContain('Confidence: medium');
    expect(output).toContain(
      'Unresolved questions: should we truncate descriptions?',
    );
    expect(output).toContain('Open conflicts:');
    expect(output).toContain('[state/detected] task:task_abc_1 @ status');
    expect(output).toContain('source="memorize.conflicts"');
    expect(output).toContain('Must-read topics:');
    expect(output).toContain('- Runtime guardrails (/rules/guardrails)');
    expect(output).toContain('source="memorize.topics"');
  });

  it('propagates task, handoff, conflict, and topic details to Codex', () => {
    const output = renderCodexStartupContext(richPayload);

    expect(output).toContain('- Priority: high');
    expect(output).toContain(
      '- Description: Render acceptance criteria and open questions in adapters.',
    );
    expect(output).toContain('- Acceptance criteria:');
    expect(output).toContain('  - Claude shows AC');
    expect(output).toContain('- Open questions:');
    expect(output).toContain('  - truncate threshold?');
    expect(output).toContain('- Risk notes:');
    expect(output).toContain('  - long descriptions may bloat context');
    expect(output).toContain('- Confidence: medium');
    expect(output).toContain(
      '- Unresolved questions: should we truncate descriptions?',
    );
    expect(output).toContain('## Open conflicts');
    expect(output).toContain('[state/detected] task:task_abc_1 @ status');
    expect(output).toContain('source="memorize.conflicts"');
    expect(output).toContain('## Must-read topics');
    expect(output).toContain('- Runtime guardrails (/rules/guardrails)');
    expect(output).toContain('source="memorize.topics"');
  });

  it('omits task description when identical to title', () => {
    const payload: StartupContextPayload = {
      ...samplePayload,
      task: { ...richTask, description: richTask.title },
    };
    const claude = renderClaudeStartupContext(payload);
    const codex = renderCodexStartupContext(payload);
    expect(claude).not.toContain('Description:');
    expect(codex).not.toContain('- Description:');
  });

  it('renders other active tasks for both adapters when present', () => {
    const payload: StartupContextPayload = {
      ...samplePayload,
      otherActiveTasks: [
        {
          id: 'task_xyz_2',
          title: 'Polish renderer budget',
          status: 'in_progress',
          assignment: {
            sessionId: 'sess_abc_9',
            actor: 'codex',
            lastSeenAt: ISO,
            freshness: 'active 5m ago',
          },
        },
      ],
    };
    const claude = renderClaudeStartupContext(payload);
    const codex = renderCodexStartupContext(payload);

    expect(claude).toContain('Other active tasks:');
    expect(claude).toContain(
      '- task_xyz_2: "Polish renderer budget" (codex, active 5m ago)',
    );
    expect(claude).toContain('source="memorize.other-active-tasks"');

    expect(codex).toContain('## Other active tasks');
    expect(codex).toContain(
      '- task_xyz_2: "Polish renderer budget" — codex, active 5m ago',
    );
    expect(codex).toContain('source="memorize.other-active-tasks"');
  });

  it('omits other active tasks section when list is empty or undefined', () => {
    const empty: StartupContextPayload = {
      ...samplePayload,
      otherActiveTasks: [],
    };
    expect(renderClaudeStartupContext(empty)).not.toContain('Other active tasks');
    expect(renderCodexStartupContext(empty)).not.toContain('Other active tasks');
    expect(renderClaudeStartupContext(samplePayload)).not.toContain(
      'Other active tasks',
    );
    expect(renderCodexStartupContext(samplePayload)).not.toContain(
      'Other active tasks',
    );
  });
});
