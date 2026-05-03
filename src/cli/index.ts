import process from 'node:process';

import { bumpHeartbeat } from '../services/session-service.js';
import { runConflictCommand } from './commands/conflict.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runEventsCommand } from './commands/events.js';
import { runHookCommand } from './commands/hook.js';
import { runInstallCommand } from './commands/install.js';
import { runMemoryIndexCommand } from './commands/memory-index.js';
import { runProjectCommand } from './commands/project.js';
import { runProjectionCommand } from './commands/projection.js';
import { runTaskCommand } from './commands/task.js';
import type { CliContext, CommandHandler } from './context.js';
import { renderScaffoldUsage } from './usage.js';

export { renderScaffoldUsage } from './usage.js';

const handlers: Record<string, CommandHandler> = {
  project: runProjectCommand,
  projection: runProjectionCommand,
  'memory-index': runMemoryIndexCommand,
  events: runEventsCommand,
  doctor: runDoctorCommand,
  install: runInstallCommand,
  hook: runHookCommand,
  task: runTaskCommand,
  conflict: runConflictCommand,
};

// Commands that manage session lifecycle themselves — skip post-command
// heartbeat for these so we never double-fire the event.
const SESSION_MANAGING_COMMANDS = new Set(['hook', 'install']);

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const ctx: CliContext = { cwd: process.cwd() };

  const handler = command ? handlers[command] : undefined;
  if (!handler) {
    console.log(renderScaffoldUsage());
    return;
  }

  await handler(args, ctx);

  if (command && !SESSION_MANAGING_COMMANDS.has(command)) {
    await bumpHeartbeat(ctx.cwd);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
