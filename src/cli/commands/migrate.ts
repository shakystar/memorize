import { migrateFromCwd } from '../../services/migrate-service.js';
import type { CliContext } from '../context.js';

export async function runMigrateCommand(
  _args: string[],
  ctx: CliContext,
): Promise<void> {
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
