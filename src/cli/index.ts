import process from 'node:process';

import { bumpHeartbeat } from '../services/session-service.js';
import { migrateToAccountLayout } from '../storage/account-migration.js';
import { runAuthCommand } from './commands/auth.js';
import { runConflictCommand } from './commands/conflict.js';
import { runConsolidateCommand } from './commands/consolidate.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runEventsCommand } from './commands/events.js';
import { runExportCommand } from './commands/export.js';
import { runHookCommand } from './commands/hook.js';
import { runInitCommand } from './commands/init.js';
import { runInstallCommand } from './commands/install.js';
import { runMcpCommand } from './commands/mcp.js';
import { runMemoryCommand } from './commands/memory.js';
import { runMemoryIndexCommand } from './commands/memory-index.js';
import { runPersonalCommand } from './commands/personal.js';
import { runMigrateCommand } from './commands/migrate.js';
import { runProjectCommand } from './commands/project.js';
import { runProjectionCommand } from './commands/projection.js';
import { runSearchCommand } from './commands/search.js';
import { runSessionCommand } from './commands/session.js';
import { runSetupCommand } from './commands/setup.js';
import { runTaskCommand } from './commands/task.js';
import { runUninstallCommand } from './commands/uninstall.js';
import { runUpdateCommand } from './commands/update.js';
import type { CliContext, CommandHandler } from './context.js';
import { renderScaffoldUsage } from './usage.js';

export { renderScaffoldUsage } from './usage.js';

const handlers: Record<string, CommandHandler> = {
  init: runInitCommand,
  auth: runAuthCommand,
  // `memorize login` — optional convenience alias for `memorize auth login`
  // (the namespaced form stays canonical, mirroring `gh auth login`).
  login: (args, ctx) => runAuthCommand(['login', ...args], ctx),
  project: runProjectCommand,
  projection: runProjectionCommand,
  memory: runMemoryCommand,
  'memory-index': runMemoryIndexCommand,
  personal: runPersonalCommand,
  events: runEventsCommand,
  migrate: runMigrateCommand,
  export: runExportCommand,
  search: runSearchCommand,
  doctor: runDoctorCommand,
  install: runInstallCommand,
  uninstall: runUninstallCommand,
  update: runUpdateCommand,
  hook: runHookCommand,
  task: runTaskCommand,
  conflict: runConflictCommand,
  consolidate: runConsolidateCommand,
  session: runSessionCommand,
  setup: runSetupCommand,
  mcp: runMcpCommand,
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
  'init',
  'install',
  'uninstall',
  'session',
  'setup',
  'consolidate',
  // `update` is machine-wide maintenance that may run outside any bound
  // project (and re-execs itself); a heartbeat from it would be wrong.
  'update',
  // `mcp` runs a long-lived stdio server; it is an MCP transport, not an agent
  // session, so it must not bump session liveness.
  'mcp',
  // `auth` manages host credentials and may run outside any bound project; a
  // heartbeat from it would falsely signal agent liveness. `login` is its alias.
  'auth',
  'login',
  // `personal` operates on the global account-level store, not a cwd project; a
  // heartbeat would falsely signal liveness on whatever project the cwd binds.
  'personal',
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

  // Help must work without a bound project, so intercept BEFORE handler
  // dispatch — otherwise `--help` is consumed as a positional (e.g. a task
  // title) and reaches requireBoundProjectId. Covers both the bare `help`
  // command and `--help`/`-h` appearing anywhere in the args.
  if (
    command === 'help' ||
    command === '--help' ||
    command === '-h' ||
    args.includes('--help') ||
    args.includes('-h')
  ) {
    console.log(renderScaffoldUsage());
    return;
  }

  const handler = command ? handlers[command] : undefined;
  if (!handler) {
    console.log(renderScaffoldUsage());
    return;
  }

  // One-time, idempotent move of any pre-account on-disk layout under the default
  // account (M1). Runs before the handler touches any store path. No-op once done
  // or on a fresh install.
  migrateToAccountLayout();

  await handler(args, ctx);

  if (command && !SESSION_MANAGING_COMMANDS.has(command)) {
    await bumpHeartbeat(ctx.cwd);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
