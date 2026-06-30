// scripts/benchmarks/e2e/consolidate-seed.ts
//
// Consolidation-ON seed: routes each haystack session through the REAL product
// pipeline — re-emit the session as a JSONL transcript, run `consolidate()`, and
// let the resulting salience-gated memories be what retrieval sees. This is the
// "measure memorize as-is" path: the product extractor + pipeline, unmodified.
//
// The ONLY benchmark-specific tweak is cwd isolation of the extractor: the
// product runs `claude -p` in the project cwd so it reads CLAUDE.md/AGENTS.md and
// scopes extraction to that domain — correct for a real project, but for
// LongMemEval (everyday dialogue unrelated to this repo) it makes claude
// self-identify as "this repo's coding agent" and refuse the content. A
// project-free cwd removes that contamination. The prompt is the product's
// (now domain-neutral) EXTRACTION_SYSTEM_PROMPT — no bench prompt injection.
import fs from 'node:fs';
import path from 'node:path';

import {
  CliConsolidator,
  consolidate,
  type Consolidator,
} from '../../../src/services/consolidate-service.js';
import { createProject } from '../../../src/services/project-service.js';
import { listValidMemories } from '../../../src/services/projection-store.js';

import type { BenchQuestion, BenchSession } from '../retrieval/dataset.js';
import type { SeededQuestion } from '../retrieval/seed.js';

type Turn = { role: string; content: string };

/** Oversized-input safety net: split a session's turns into chunks no larger
 *  than `maxChars` at TURN boundaries, so a huge session never exceeds the
 *  extractor context. A single over-budget turn still goes alone. */
export function chunkTurns(turns: Turn[], maxChars: number): Turn[][] {
  const chunks: Turn[][] = [];
  let cur: Turn[] = [];
  let len = 0;
  for (const turn of turns) {
    if (cur.length > 0 && len + turn.content.length > maxChars) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(turn);
    len += turn.content.length;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks.length > 0 ? chunks : [[]];
}

/** Re-emit turns as the JSONL transcript shape `readConversationSince` strips:
 *  user content as a string, assistant content as a [{type:'text'}] block. */
function turnsToJsonl(turns: Turn[]): string {
  return (
    turns
      .map((t) =>
        t.role === 'assistant'
          ? JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t.content }] } })
          : JSON.stringify({ type: 'user', message: { content: t.content } }),
      )
      .join('\n') + '\n'
  );
}

/** Chronological order (oldest→newest); date-less sessions keep input order. */
function chronological(sessions: BenchSession[]): BenchSession[] {
  return sessions
    .map((session, i) => ({ session, i }))
    .sort((a, b) => {
      const c = (a.session.date ?? '').localeCompare(b.session.date ?? '');
      return c !== 0 ? c : a.i - b.i;
    })
    .map((x) => x.session);
}

export interface ConsolidateSeedOptions {
  rootPath: string;
  /** Where per-session JSONL transcripts are written (outside MEMORIZE_ROOT). */
  transcriptDir: string;
  /** Project-free cwd for the extractor CLI (no CLAUDE.md/.git in scope). */
  extractorCwd: string;
  /** Turn-chunking budget (chars). */
  maxChunkChars?: number;
  /** Override extractor (tests). Default = product CliConsolidator(claude) with
   *  the isolated cwd — the product pipeline, only cwd differs. */
  consolidator?: Consolidator;
}

export async function seedQuestionConsolidated(
  q: BenchQuestion,
  opts: ConsolidateSeedOptions,
): Promise<SeededQuestion> {
  const project = await createProject({ title: q.questionId, rootPath: opts.rootPath });
  const projectId = project.id;
  const maxChunkChars = opts.maxChunkChars ?? 200_000;
  const consolidator =
    opts.consolidator ?? new CliConsolidator({ command: 'claude', cwd: opts.extractorCwd });

  fs.mkdirSync(opts.transcriptDir, { recursive: true });

  for (const session of chronological(q.sessions)) {
    const chunks = chunkTurns(session.turns ?? [], maxChunkChars);
    for (let i = 0; i < chunks.length; i += 1) {
      const file = path.join(
        opts.transcriptDir,
        `${q.questionId}__${session.sessionId}__${i}.jsonl`,
      );
      fs.writeFileSync(file, turnsToJsonl(chunks[i]!));
      // Bench robustness: a single session's extractor failure (transient
      // claude -p exit, rate limit) must NOT abort the whole run. Retry once,
      // then skip this session — its memories are simply absent, logged not
      // faked (no benchmark gaming; a skipped session is honest data loss).
      try {
        await consolidate({
          projectId,
          actor: 'benchmark',
          sessionId: session.sessionId,
          transcriptPath: file,
          boundary: 'manual',
          consolidator,
          // The benchmark's dialogue IS personal-life content; it must stay in
          // the measured project store, not be siphoned into the personal store.
          routePersonal: false,
        });
      } catch {
        try {
          await consolidate({
            projectId,
            actor: 'benchmark',
            sessionId: session.sessionId,
            transcriptPath: file,
            boundary: 'manual',
            consolidator,
          });
        } catch (err2) {
          process.stderr.write(
            `WARN: consolidate failed for ${q.questionId}/${session.sessionId} ` +
              `after retry, skipping: ${err2 instanceof Error ? err2.message : String(err2)}\n`,
          );
        }
      }
    }
  }

  const sessionIdByMemoryId = new Map<string, string>();
  for (const { memory } of listValidMemories(projectId)) {
    if (memory.sessionId) sessionIdByMemoryId.set(memory.id, memory.sessionId);
  }
  return { projectId, sessionIdByMemoryId };
}
