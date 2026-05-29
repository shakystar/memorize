import fs from 'node:fs/promises';

import { readEvents } from '../storage/event-store.js';
import { ensureParentDir } from '../storage/fs-utils.js';
import { requireBoundProjectId } from './project-service.js';

/**
 * Serialize the SQLite event log back to NDJSON (one JSON object per line),
 * in `seq` order. This is the human-readable / inspection escape hatch and
 * the round-trip counterpart of `migrate`.
 */
export async function exportEventsToNdjson(projectId: string): Promise<string> {
  const events = await readEvents(projectId);
  return events.map((event) => JSON.stringify(event)).join('\n');
}

export interface ExportResult {
  eventCount: number;
  /** Absolute file path written, or undefined when streamed to stdout. */
  outFile?: string;
  /** NDJSON text (always returned so the caller can print to stdout). */
  ndjson: string;
}

/**
 * Export from the bound project. When `outFile` is given the NDJSON is
 * written there (with a trailing newline); otherwise the caller prints the
 * returned text to stdout.
 */
export async function exportFromCwd(
  cwd: string,
  outFile?: string,
): Promise<ExportResult> {
  const projectId = await requireBoundProjectId(cwd);
  const events = await readEvents(projectId);
  const ndjson = events.map((event) => JSON.stringify(event)).join('\n');

  if (outFile) {
    await ensureParentDir(outFile);
    await fs.writeFile(outFile, ndjson ? `${ndjson}\n` : '', 'utf8');
  }

  return {
    eventCount: events.length,
    ...(outFile ? { outFile } : {}),
    ndjson,
  };
}
