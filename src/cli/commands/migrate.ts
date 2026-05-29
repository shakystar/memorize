import {
  cleanupEventsBackupFromCwd,
  migrateFromCwd,
} from '../../services/migrate-service.js';
import type { CliContext } from '../context.js';

export async function runMigrateCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  if (args[0] === 'cleanup') {
    const cleanup = await cleanupEventsBackupFromCwd(ctx.cwd);
    switch (cleanup.status) {
      case 'removed':
        console.log('Removed events.bak/ backup directory.');
        return;
      case 'no-backup':
        console.log('No events.bak/ backup directory to remove.');
        return;
      case 'not-migrated':
        console.log(
          'Project not yet migrated from NDJSON; keeping events.bak/ (if any) as a safety net.',
        );
        return;
    }
  }

  const result = await migrateFromCwd(ctx.cwd);
  switch (result.status) {
    case 'already-migrated':
      console.log('Already migrated from NDJSON; nothing to do.');
      return;
    case 'no-legacy-events':
      console.log('No legacy events/*.ndjson found; marked as migrated.');
      return;
    case 'migrated':
      console.log(
        `Migrated ${result.legacyEventCount} legacy event(s) ` +
          `(${result.insertedCount} inserted) into SQLite. ` +
          `Moved events/*.ndjson to events.bak/.`,
      );
      return;
  }
}
