import process from 'node:process';

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

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const ctx: CliContext = { cwd: process.cwd() };

  const handler = command ? handlers[command] : undefined;
  if (!handler) {
    console.log(renderScaffoldUsage());
    return;
  }

  await handler(args, ctx);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
