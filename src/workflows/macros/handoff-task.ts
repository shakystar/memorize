import {
  getBoundProjectId,
  readProject,
} from '../../services/project-service.js';
import { createHandoff } from '../../services/task-service.js';

export const HANDOFF_INTENT_NOTICE = [
  'Note: Handoff records intent, context, and decisions only —',
  '      not code state. The next agent verifies tests and git',
  '      state independently at session start.',
].join('\n');

const MISSING_NEXT_HELP = [
  'Handoff requires --next to capture what the next agent should do.',
  '',
  'Use either:',
  '  memorize do "hand off to codex" --summary "..." --next "..."',
  '  memorize do                             # interactive prompts',
  '',
  HANDOFF_INTENT_NOTICE,
].join('\n');

export interface HandoffWorkflowOptions {
  summary?: string;
  nextAction?: string;
  fromActor?: string;
  toActor?: string;
  doneItems?: string[];
  remainingItems?: string[];
  warnings?: string[];
  unresolvedQuestions?: string[];
  confidence?: 'low' | 'medium' | 'high';
}

export async function handoffTaskWorkflow(
  cwd: string,
  sentence: string,
  targetActor?: string,
  options: HandoffWorkflowOptions = {},
): Promise<string> {
  const projectId = await getBoundProjectId(cwd);
  if (!projectId) {
    throw new Error('No project bound to current directory.');
  }

  const project = await readProject(projectId);
  const activeTaskId = project?.activeTaskIds[0];
  if (!activeTaskId) {
    throw new Error('No active task to hand off. Create a task first.');
  }

  const nextAction = options.nextAction;
  if (!nextAction) {
    return MISSING_NEXT_HELP;
  }

  const handoff = await createHandoff({
    projectId,
    taskId: activeTaskId,
    fromActor: options.fromActor ?? 'user',
    toActor: options.toActor ?? targetActor ?? 'next-agent',
    summary: options.summary ?? sentence,
    nextAction,
    ...(options.doneItems?.length ? { doneItems: options.doneItems } : {}),
    ...(options.remainingItems?.length
      ? { remainingItems: options.remainingItems }
      : {}),
    ...(options.warnings?.length ? { warnings: options.warnings } : {}),
    ...(options.unresolvedQuestions?.length
      ? { unresolvedQuestions: options.unresolvedQuestions }
      : {}),
    ...(options.confidence ? { confidence: options.confidence } : {}),
  });

  return `Created handoff ${handoff.id} → ${handoff.toActor}\n\n${HANDOFF_INTENT_NOTICE}`;
}
