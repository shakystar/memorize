// scripts/benchmarks/e2e/checkpoint.ts
import fs from 'node:fs';

import type { QuestionResult } from './score-e2e.js';

/** One scored question, persisted so a stopped run can resume. */
export interface CheckpointRecord extends QuestionResult {
  questionId: string;
}

/** Read a JSONL checkpoint into a map keyed by questionId. A missing file
 *  yields an empty map; a truncated or garbled final line (an abrupt kill mid
 *  append) is skipped rather than fatal, so the resume still picks up every
 *  fully written record. */
export function loadCheckpoint(filePath: string): Map<string, CheckpointRecord> {
  const done = new Map<string, CheckpointRecord>();
  if (!fs.existsSync(filePath)) return done;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: CheckpointRecord;
    try {
      record = JSON.parse(trimmed) as CheckpointRecord;
    } catch {
      continue; // half-written last line from a kill — ignore it
    }
    if (typeof record.questionId === 'string') done.set(record.questionId, record);
  }
  return done;
}

/** Append one scored question as a JSONL line. Each call opens, writes, and
 *  closes the file, so a later crash keeps everything already recorded. */
export function appendCheckpoint(filePath: string, record: CheckpointRecord): void {
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}
