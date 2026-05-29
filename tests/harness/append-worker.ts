/**
 * Multi-process contention worker for tests/integration/cross-process-append.
 * Run as a SEPARATE OS process (via tsx) so it opens its OWN better-sqlite3
 * connection to the shared project DB — exercising real cross-process file
 * locking (WAL + busy_timeout), which in-process Promise.all tests cannot.
 *
 * Argv: <projectId> <count>. MEMORIZE_ROOT is inherited from the parent env.
 * Appends <count> events, then exits 0. Any SQLITE_BUSY (or other) error
 * propagates as a non-zero exit + stderr, which the test asserts against.
 */
import { appendEvent } from '../../src/storage/event-store.js';
import { closeAll } from '../../src/storage/db.js';

async function main(): Promise<void> {
  const projectId = process.argv[2]!;
  const count = Number(process.argv[3]);
  for (let i = 0; i < count; i++) {
    await appendEvent({
      type: 'task.created',
      projectId,
      scopeType: 'task',
      scopeId: `task_${process.pid}_${i}`,
      actor: `pid_${process.pid}`,
      payload: { title: `from ${process.pid} #${i}` },
    });
  }
  closeAll();
}

main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof Error ? `${error.message}\n` : `${String(error)}\n`,
  );
  process.exit(1);
});
