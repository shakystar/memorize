import { describe, expect, it } from 'vitest';

import type {
  Checkpoint,
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

  it('renders latest compact summary for both adapters when present', () => {
    const checkpoint: Checkpoint = {
      id: 'checkpoint_abc_1',
      schemaVersion: '0.1.0',
      createdAt: ISO,
      updatedAt: ISO,
      projectId: 'proj_abc_1',
      taskId: 'task_abc_1',
      sessionId: 'sess_abc_1',
      summary: 'Compacted: implemented renderer scaffolding',
      taskUpdates: [],
      projectUpdates: [],
      promotedDecisions: [],
      deferredItems: ['Wire character budget', 'Add fixture coverage'],
      discardableItems: [],
    };
    const payload: StartupContextPayload = {
      ...samplePayload,
      latestCheckpoint: checkpoint,
    };
    const claude = renderClaudeStartupContext(payload);
    const codex = renderCodexStartupContext(payload);

    expect(claude).toContain(
      'Latest compact summary: Compacted: implemented renderer scaffolding',
    );
    expect(claude).toContain('Deferred items:');
    expect(claude).toContain('- Wire character budget');
    expect(claude).toContain('source="memorize.checkpoint"');

    expect(codex).toContain('## Latest compact summary');
    expect(codex).toContain(
      '- Summary: Compacted: implemented renderer scaffolding',
    );
    expect(codex).toContain('  - Wire character budget');
    expect(codex).toContain('source="memorize.checkpoint"');
  });

  it('omits compact summary section when no checkpoint present', () => {
    expect(renderClaudeStartupContext(samplePayload)).not.toContain(
      'compact summary',
    );
    expect(renderCodexStartupContext(samplePayload)).not.toContain(
      'compact summary',
    );
  });

  it('drops low-priority blocks and renders a budget notice when payload exceeds budget', () => {
    const payload: StartupContextPayload = {
      ...samplePayload,
      task: richTask,
      latestHandoff: richHandoff,
      mustReadTopics: [
        { id: 'topic_1', title: 'Topic A', path: '/a' },
        { id: 'topic_2', title: 'Topic B', path: '/b' },
      ],
      otherActiveTasks: [
        {
          id: 'task_other_1',
          title: 'Other work',
          status: 'in_progress',
          assignment: {
            sessionId: 'sess_other',
            actor: 'codex',
            lastSeenAt: ISO,
            freshness: 'active just now',
          },
        },
      ],
    };

    // Budget tight enough to fit project + task + handoff (~750 chars)
    // but trip on other-active-tasks (~135 chars), forcing strict-stop
    // semantics to drop topics as well.
    const tightBudget = 850;
    const claude = renderClaudeStartupContext(payload, { budget: tightBudget });
    const codex = renderCodexStartupContext(payload, { budget: tightBudget });

    expect(claude).toContain('Project: Memorize shared context system');
    expect(claude).toContain('Task: Wire renderer fields');
    expect(claude).toContain('Latest handoff:');
    expect(claude).not.toContain('Must-read topics:');
    expect(claude).not.toContain('Other active tasks:');
    expect(claude).toContain('source="memorize.budget-notice"');
    expect(claude).toContain('Sections dropped to fit budget');

    expect(codex).toContain('## Project summary');
    expect(codex).toContain('## Current task');
    expect(codex).toContain('## Latest handoff');
    expect(codex).not.toContain('## Must-read topics');
    expect(codex).not.toContain('## Other active tasks');
    expect(codex).toContain('## Budget notice');
  });

  it('does not emit a budget notice when payload fits within budget', () => {
    const claude = renderClaudeStartupContext(richPayload);
    const codex = renderCodexStartupContext(richPayload);
    expect(claude).not.toContain('memorize.budget-notice');
    expect(codex).not.toContain('memorize.budget-notice');
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
