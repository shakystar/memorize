import process from 'node:process';

import { bumpHeartbeat } from '../services/session-service.js';
import { runConflictCommand } from './commands/conflict.js';
import { runConsolidateCommand } from './commands/consolidate.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runEventsCommand } from './commands/events.js';
import { runExportCommand } from './commands/export.js';
import { runHookCommand } from './commands/hook.js';
import { runInstallCommand } from './commands/install.js';
import { runMemoryCommand } from './commands/memory.js';
import { runMemoryIndexCommand } from './commands/memory-index.js';
import { runMigrateCommand } from './commands/migrate.js';
import { runProjectCommand } from './commands/project.js';
import { runProjectionCommand } from './commands/projection.js';
import { runSearchCommand } from './commands/search.js';
import { runSessionCommand } from './commands/session.js';
import { runSetupCommand } from './commands/setup.js';
import { runTaskCommand } from './commands/task.js';
import { runUninstallCommand } from './commands/uninstall.js';
import type { CliContext, CommandHandler } from './context.js';
import { renderScaffoldUsage } from './usage.js';

export { renderScaffoldUsage } from './usage.js';

const handlers: Record<string, CommandHandler> = {
  project: runProjectCommand,
  projection: runProjectionCommand,
  memory: runMemoryCommand,
  'memory-index': runMemoryIndexCommand,
  events: runEventsCommand,
  migrate: runMigrateCommand,
  export: runExportCommand,
  search: runSearchCommand,
  doctor: runDoctorCommand,
  install: runInstallCommand,
  uninstall: runUninstallCommand,
  hook: runHookCommand,
  task: runTaskCommand,
  conflict: runConflictCommand,
  consolidate: runConsolidateCommand,
  session: runSessionCommand,
  setup: runSetupCommand,
};

// Commands that manage session lifecycle themselves — skip post-command
// heartbeat for these so we never double-fire the event. `session reap`
// is included because firing a heartbeat on the just-reaped session
// would resurrect it as 'active' the moment after we abandoned it.
// `consolidate` is included because it runs as a detached background
// child of boundary hooks (#46) — a heartbeat from it would falsely
// signal agent liveness on a session that may just have ended.
const SESSION_MANAGING_COMMANDS = new Set([
  'hook',
  'install',
  'uninstall',
  'session',
  'setup',
  'consolidate',
]);

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const ctx: CliContext = { cwd: process.cwd() };

  // #82 — version confusion (stale devDependency vs global install) was half
  // of the first external bug report. Resolve from the package's own
  // package.json so the answer is about THIS binary, wherever it came from.
  if (command === 'version' || command === '--version' || command === '-v') {
    const { createRequire } = await import('node:module');
    const pkg = createRequire(import.meta.url)('../../package.json') as {
      version: string;
    };
    console.log(pkg.version);
    return;
  }

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
