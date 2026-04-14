import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderClaudeStartupContext } from '../../src/adapters/claude/renderer.js';
import { renderCodexStartupContext } from '../../src/adapters/codex/renderer.js';
import { loadStartContext } from '../../src/services/context-service.js';
import { createProject } from '../../src/services/project-service.js';
import {
  createCheckpoint,
  createHandoff,
  createTask,
} from '../../src/services/task-service.js';

const ID_PATTERN =
  /^(handoff|checkpoint|task|proj|sync|ws|session|evt|decision|rule|conflict)_[a-z0-9]+_[a-z0-9]+$/;
const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    if (ID_PATTERN.test(value)) {
      const prefix = value.split('_')[0]?.toUpperCase();
      return `<${prefix}_ID>`;
    }
    if (ISO_PATTERN.test(value)) {
      return '<ISO>';
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, inner]) => [key, normalize(inner)] as const,
    );
    return Object.fromEntries(entries);
  }
  return value;
}

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-golden-hc-'));
  process.env.MEMORIZE_ROOT = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('handoff and checkpoint golden outputs', () => {
  it('generates a handoff entity with stable shape', async () => {
    const project = await createProject({
      title: 'Golden project',
      rootPath: sandbox,
    });
    const task = await createTask({
      projectId: project.id,
      title: 'Golden task',
      actor: 'user',
    });
    const handoff = await createHandoff({
      projectId: project.id,
      taskId: task.id,
      fromActor: 'claude',
      toActor: 'codex',
      summary: 'Finished wiring the handoff CLI.',
      nextAction: 'Run integration tests against the adapter.',
      doneItems: ['parse flags', 'resolve active task'],
      remainingItems: ['document flag surface'],
      warnings: ['--confidence must be one of low|medium|high'],
      unresolvedQuestions: ['should the actor default change?'],
      confidence: 'high',
    });

    expect(normalize(handoff)).toMatchInlineSnapshot(`
      {
        "confidence": "high",
        "createdAt": "<ISO>",
        "doneItems": [
          "parse flags",
          "resolve active task",
        ],
        "fromActor": "claude",
        "id": "<HANDOFF_ID>",
        "nextAction": "Run integration tests against the adapter.",
        "projectId": "<PROJ_ID>",
        "remainingItems": [
          "document flag surface",
        ],
        "requiredContextRefs": [],
        "schemaVersion": "0.1.0",
        "summary": "Finished wiring the handoff CLI.",
        "taskId": "<TASK_ID>",
        "toActor": "codex",
        "unresolvedQuestions": [
          "should the actor default change?",
        ],
        "updatedAt": "<ISO>",
        "warnings": [
          "--confidence must be one of low|medium|high",
        ],
      }
    `);
  });

  it('generates a checkpoint entity with stable shape', async () => {
    const project = await createProject({
      title: 'Golden project',
      rootPath: sandbox,
    });
    const task = await createTask({
      projectId: project.id,
      title: 'Golden task',
      actor: 'user',
    });
    const checkpoint = await createCheckpoint({
      projectId: project.id,
      taskId: task.id,
      sessionId: 'golden-test-session',
      summary: 'Mid-session snapshot after CLI wiring.',
      taskUpdates: ['flag parser added'],
      projectUpdates: ['sync scaffolding present'],
      deferredItems: ['polish error messages'],
      discardableItems: ['sketch notes'],
    });

    expect(normalize(checkpoint)).toMatchInlineSnapshot(`
      {
        "createdAt": "<ISO>",
        "deferredItems": [
          "polish error messages",
        ],
        "discardableItems": [
          "sketch notes",
        ],
        "id": "<CHECKPOINT_ID>",
        "projectId": "<PROJ_ID>",
        "projectUpdates": [
          "sync scaffolding present",
        ],
        "promotedDecisions": [],
        "schemaVersion": "0.1.0",
        "sessionId": "golden-test-session",
        "summary": "Mid-session snapshot after CLI wiring.",
        "taskId": "<TASK_ID>",
        "taskUpdates": [
          "flag parser added",
        ],
        "updatedAt": "<ISO>",
      }
    `);
  });

  it('propagates handoff state into the task projection and startup payload', async () => {
    const project = await createProject({
      title: 'Golden project',
      rootPath: sandbox,
    });
    const task = await createTask({
      projectId: project.id,
      title: 'Golden task',
      actor: 'user',
    });
    await createHandoff({
      projectId: project.id,
      taskId: task.id,
      fromActor: 'claude',
      toActor: 'codex',
      summary: 'Finished wiring the handoff CLI.',
      nextAction: 'Run integration tests against the adapter.',
    });

    const startup = await loadStartContext({
      projectId: project.id,
      taskId: task.id,
    });

    expect(startup.task?.status).toBe('handoff_ready');
    expect(startup.task?.latestHandoffId).toBeDefined();
    expect(startup.latestHandoff?.toActor).toBe('codex');
    expect(startup.latestHandoff?.nextAction).toBe(
      'Run integration tests against the adapter.',
    );

    const claudeOutput = renderClaudeStartupContext(startup);
    expect(claudeOutput).toContain('Latest handoff: claude → codex');
    expect(claudeOutput).toContain(
      'Next action: Run integration tests against the adapter.',
    );

    const codexOutput = renderCodexStartupContext(startup);
    expect(codexOutput).toContain('## Latest handoff');
    expect(codexOutput).toContain('- From: claude → codex');
    expect(codexOutput).toContain(
      '- Next action: Run integration tests against the adapter.',
    );
  });
});
