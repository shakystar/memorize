import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { HANDOFF_INTENT_NOTICE } from '../workflows/macros/handoff-task.js';
import type { ResolvedIntent } from '../workflows/intents.js';
import { runWorkflow, type WorkflowOptions } from '../workflows/macros/run.js';

type Rl = readline.Interface;

const CONFIDENCE_VALUES = ['low', 'medium', 'high'] as const;
type Confidence = (typeof CONFIDENCE_VALUES)[number];

function isConfidence(value: string): value is Confidence {
  return (CONFIDENCE_VALUES as readonly string[]).includes(value);
}

async function collectLines(rl: Rl, label: string): Promise<string[]> {
  output.write(`${label} (one per line, empty line to finish):\n`);
  const items: string[] = [];
  for (;;) {
    const line = (await rl.question('> ')).trim();
    if (line === '') break;
    items.push(line);
  }
  return items;
}

async function ask(rl: Rl, prompt: string, fallback = ''): Promise<string> {
  const answer = (await rl.question(prompt)).trim();
  return answer || fallback;
}

async function runHandoffInteractive(rl: Rl, cwd: string): Promise<void> {
  output.write('\n');
  output.write(`${HANDOFF_INTENT_NOTICE}\n\n`);

  const toActor = await ask(rl, 'Target actor [next-agent]: ', 'next-agent');
  const fromActor = await ask(rl, 'From actor [user]: ', 'user');
  const summary = await ask(rl, 'Short summary: ');
  const nextAction = await ask(rl, 'Next action: ');

  if (!summary || !nextAction) {
    output.write(
      '\nHandoff cancelled: summary and next action are required.\n',
    );
    return;
  }

  const doneItems = await collectLines(rl, 'Done items (scope completed)');
  const remainingItems = await collectLines(
    rl,
    'Remaining items (scope still open)',
  );
  const warnings = await collectLines(rl, 'Warnings');
  const unresolvedQuestions = await collectLines(rl, 'Open questions');
  const confidenceAnswer = await ask(
    rl,
    'Confidence (low/medium/high) [medium]: ',
    'medium',
  );
  const confidence: Confidence = isConfidence(confidenceAnswer)
    ? confidenceAnswer
    : 'medium';

  const intent: ResolvedIntent = {
    intent: 'task.handoff',
    raw: summary,
    targetActor: toActor,
  };
  const options: WorkflowOptions = {
    summary,
    nextAction,
    fromActor,
    toActor,
    doneItems,
    remainingItems,
    warnings,
    unresolvedQuestions,
    confidence,
  };

  output.write('\n');
  output.write(`${await runWorkflow(intent, cwd, options)}\n`);
}

async function runCheckpointInteractive(rl: Rl, cwd: string): Promise<void> {
  output.write('\nCheckpoint records a mid-session snapshot of scope.\n\n');

  const summary = await ask(rl, 'Short summary: ');
  if (!summary) {
    output.write('\nCheckpoint cancelled: summary is required.\n');
    return;
  }

  const taskUpdates = await collectLines(rl, 'Task updates');
  const projectUpdates = await collectLines(rl, 'Project updates');
  const deferredItems = await collectLines(rl, 'Deferred items');
  const discardableItems = await collectLines(rl, 'Discardable items');

  const intent: ResolvedIntent = {
    intent: 'task.checkpoint',
    raw: summary,
  };
  const options: WorkflowOptions = {
    summary,
    taskUpdates,
    projectUpdates,
    deferredItems,
    discardableItems,
  };

  output.write('\n');
  output.write(`${await runWorkflow(intent, cwd, options)}\n`);
}

export async function runInteractiveDo(cwd: string): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    output.write('Memorize interactive mode\n\n');
    output.write('What do you want to record?\n');
    output.write('  1) handoff\n');
    output.write('  2) checkpoint\n');
    output.write('  q) quit\n\n');

    const choiceRaw = (await rl.question('> ')).trim().toLowerCase();
    if (choiceRaw === '' || choiceRaw === 'q' || choiceRaw === 'quit') {
      output.write('Cancelled.\n');
      return;
    }

    if (choiceRaw === '1' || choiceRaw === 'handoff') {
      await runHandoffInteractive(rl, cwd);
      return;
    }
    if (choiceRaw === '2' || choiceRaw === 'checkpoint') {
      await runCheckpointInteractive(rl, cwd);
      return;
    }

    output.write(`Unknown choice: ${choiceRaw}\n`);
  } finally {
    rl.close();
  }
}
