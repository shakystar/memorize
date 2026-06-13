// Shared substrate for the #99 decision miss-rate measurement.
//
// Pulled out of decision-label.ts so the judge stage and the miss-rate /
// semantic-matcher stage share ONE definition of: where the DB lives, how a
// transcript is reduced to conversational turns, how the local `claude` CLI
// judge is invoked, and how the captured-decision set is read from the DB.
//
// Refs issue #99, discussion #98. Read-only over the DB; the judge call is the
// SAME backend the consolidator uses (the `claude` CLI on PATH, no API key).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

// Mirror src/services/consolidate-service.ts — the only slice of a transcript
// the extractor is ever handed.
export const TRANSCRIPT_TAIL_BYTES = 16 * 1024;
// Generous backstop, not a deadline: the largest dogfood sessions take several
// minutes to label, and timing one out would silently drop its decisions from
// the denominator. Long enough to let big transcripts finish in the background;
// short enough to catch a genuinely hung CLI (the run is bounded-parallel, so a
// real hang would otherwise stall a worker forever).
export const JUDGE_TIMEOUT_MS = 1_200_000;
// Above this much stripped conversational text we'd need chunking; we refuse
// rather than silently truncate (a truncated denominator understates the miss
// rate). The largest memorize session sits well under it.
export const MAX_PROMPT_CHARS = 500_000;

export function resolveDbPath(arg: string): string {
  if (arg.endsWith('.db') || fs.existsSync(arg)) return arg;
  const root = process.env.MEMORIZE_ROOT ?? path.join(os.homedir(), '.memorize');
  return path.join(root, 'projects', arg, 'memorize.db');
}

// --- transcript -> conversational text --------------------------------------

export interface Turn {
  role: 'user' | 'agent';
  text: string;
}

/**
 * Reduce a transcript .jsonl to the conversational turns a decision could be
 * stated in: user message text and assistant *visible* text. Tool inputs,
 * tool results, and assistant thinking are dropped — decisions are
 * communicated in plain turns, and the bulk bytes (#99 cat-2) are tool I/O.
 */
export function readConversation(transcriptPath: string): Turn[] {
  const turns: Turn[] = [];
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = obj as { type?: string; message?: { content?: unknown } };
    if (rec.type === 'user') {
      const content = rec.message?.content;
      if (typeof content === 'string') {
        if (content.trim()) turns.push({ role: 'user', text: content.trim() });
      } else if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; text?: string }>) {
          if (block.type === 'text' && block.text?.trim()) {
            turns.push({ role: 'user', text: block.text.trim() });
          }
        }
      }
    } else if (rec.type === 'assistant') {
      const content = rec.message?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; text?: string }>) {
          if (block.type === 'text' && block.text?.trim()) {
            turns.push({ role: 'agent', text: block.text.trim() });
          }
        }
      }
    }
  }
  return turns;
}

export function renderConversation(turns: Turn[]): string {
  return turns
    .map((t) => `### ${t.role === 'user' ? 'USER' : 'AGENT'}\n${t.text}`)
    .join('\n\n');
}

// --- judge (local claude CLI) -----------------------------------------------

/**
 * Run a prompt through the local `claude` CLI in headless mode — the SAME
 * backend the consolidator's CliConsolidator uses, so the judge sees what the
 * extractor would. Hooks suppressed so labeling a transcript does not itself
 * write observations.
 */
export function runCli(prompt: string, timeoutMs = JUDGE_TIMEOUT_MS): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'text'], {
      env: { ...process.env, MEMORIZE_SUPPRESS_HOOKS: '1' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (c) => (stdout += String(c)));
    child.stderr.on('data', (c) => (stderr += String(c)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`cli timed out after ${timeoutMs}ms`));
      else if (code !== 0) reject(new Error(`cli exited ${code}: ${stderr.slice(0, 200)}`));
      else resolve(stdout);
    });
    child.stdin.end(prompt);
  });
}

/** Tolerant: pull the first JSON array out of a model reply. */
export function parseJsonArray<T>(raw: string): T[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON array in model output:\n${raw.slice(0, 300)}`);
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error('model output is not an array');
  return parsed as T[];
}

// --- judge labels (the denominator) -----------------------------------------

export interface Label {
  type: 'commitment' | 'standing';
  statement: string;
  quote: string;
  by: 'user' | 'agent';
  accepted?: string;
  confidence: number;
}

export const JUDGE_PROMPT = `You are labeling a development-session transcript for a MEASUREMENT. Your output is the ground-truth denominator for a capture-miss-rate metric — be precise, not generous.

TASK: extract every DECISION or STANDING DIRECTIVE that was actually established in this conversation.

Include an item ONLY if it passes one of these operational tests. The COMMITMENT vs STANDING split is by LIFECYCLE — apply it strictly, it is the most common labeling error:
- COMMITMENT — a specific thing the team committed to DO, which COMPLETES. Once done you would answer "yes, done" and it stops applying. A one-off instruction to do something before/while working ("document these gaps first", "git init the repo", "ship X as a patch") is a COMMITMENT even when phrased like a rule — the test is whether it is discharged by being done, not whether it sounds general.
- STANDING — a standard, preference, fact, or rule that PERSISTS and keeps constraining future work indefinitely, until someone explicitly changes it ("always use the @scoped package name", "dogfood before every publish"). If it can be "finished", it is NOT standing.

DIRECTIVE FORM — do NOT mistake a politely phrased instruction for a question. Users routinely issue decisions as soft requests or tag-questions, especially in Korean: "...진행해줄래?", "...하면 되지?", "...배포해", "이렇게 갈까?". When the user uses such a turn to AUTHORIZE or INSTRUCT, and the agent then acts on it, that IS a decision (usually a COMMITMENT) — include it. Only EXCLUDE genuine information-seeking questions ("이 PR 내용이 뭐야?", "어떻게 동작해?") that ask for an explanation rather than direct an action.

EXCLUDE strictly:
- brainstorming, options weighed and dropped, genuine information-seeking questions (see DIRECTIVE FORM above — an action-directing request is NOT such a question), hypotheticals, restated background;
- anything the agent merely PROPOSED that the user did not accept — an agent suggestion counts ONLY if the user confirmed it (an explicit "ok / ㅇㅋ / ㅇㅇ / do it" on that point, or the user then acting on it);
- do NOT double-count: if the user gives one instruction and the agent enumerates the concrete items it covers, count the concrete decisions that carry independent content (e.g. a specific validation rule) — do NOT also emit the umbrella instruction AND a restated general-principle version of it as separate items.

For each item output an object:
  {"type":"commitment"|"standing","statement":"<one-line paraphrase>","quote":"<verbatim snippet, see QUOTE RULE>","by":"user"|"agent","accepted":"<how the user confirmed it, or 'unilateral-agent' if they did not>","confidence":<0.0-1.0>}

QUOTE RULE — inclusion and quoting are SEPARATE. Decide inclusion ONLY by the operational tests above; NEVER drop a real decision because it is hard to quote. The decision was actually stated in this transcript, so a verbatim span always exists — find it.
- Copy the quote CHARACTER-FOR-CHARACTER from a turn in the transcript above. Do NOT paraphrase, translate, summarise, or stitch fragments together — the quote string must appear, exactly, somewhere in the transcript.
- Quote the SUBSTANCE of the decision (the sentence stating the rule/commitment), at least ~15 characters. NEVER quote a bare acknowledgement token like "ㅇㅇ", "ok", "굿", "A", "배포해". If the decision is the user confirming the agent's proposal, quote the AGENT's substantive line that was confirmed (and set accepted to describe the confirmation).
- Prefer a span long and distinctive enough to occur only once in the transcript.

Output ONLY a JSON array of these objects. No prose, no markdown fences. If there are no qualifying decisions, output [].

TRANSCRIPT:
`;

// --- DB reads ---------------------------------------------------------------

export interface CapturedDecision {
  text: string;
  sessionIds: string[];
}

/**
 * Every kind=decision memory in the DB, with the set of sessions its source
 * observations came from. This is the FULL captured set a present decision is
 * matched against (#99: semantic match against the whole set, not per-session
 * count — captured and present sets are disjoint by topic).
 */
export function readCapturedDecisions(db: Database.Database): CapturedDecision[] {
  const obsToSession = new Map<string, string>();
  for (const r of db.prepare('SELECT id, session_id FROM observations').all() as {
    id: string;
    session_id: string;
  }[]) {
    obsToSession.set(r.id, r.session_id);
  }
  const out: CapturedDecision[] = [];
  for (const m of db
    .prepare(
      "SELECT json_extract(data,'$.text') AS text, json_extract(data,'$.sourceObservationIds') AS ids FROM memories WHERE kind='decision'",
    )
    .all() as { text: string | null; ids: string | null }[]) {
    if (!m.text) continue;
    const ids = (JSON.parse(m.ids ?? '[]') as string[]) ?? [];
    const sessionIds = [
      ...new Set(ids.map((id) => obsToSession.get(id)).filter((s): s is string => Boolean(s))),
    ];
    out.push({ text: m.text, sessionIds });
  }
  return out;
}

/** session_id -> most recent transcriptPath carried by its observations. */
export function readSessionTranscripts(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT session_id, json_extract(data,'$.transcriptPath') AS tp
       FROM observations WHERE tp IS NOT NULL`,
    )
    .all() as { session_id: string; tp: string }[];
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.session_id, r.tp); // last wins
  return m;
}

/** session_id -> observation count (0 == cat-1, transcript never read). */
export function readObservationCounts(db: Database.Database): Map<string, number> {
  const rows = db
    .prepare('SELECT session_id, COUNT(*) AS c FROM observations GROUP BY session_id')
    .all() as { session_id: string; c: number }[];
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.session_id, r.c);
  return m;
}

export interface TranscriptUnit {
  transcriptPath: string;
  uuid: string; // stable id = .jsonl basename; the cache key
  sessionIds: string[]; // distinct non-null sessions whose obs carry this path
  obsCount: number; // observations carrying this path (always >= 1)
}

/**
 * The unit of measurement is a TRANSCRIPT, not a session. Keying by session_id
 * is wrong: observations captured without a resolvable session_id (NULL) all
 * collapse to one key, so several distinct transcripts share it and last-wins
 * silently drops the rest from the denominator (#101 no-silent-caps). Iterating
 * over distinct transcriptPaths labels every transcript exactly once.
 *
 * NOTE on cat-1: a transcript only appears here because an observation carried
 * its path, so obsCount >= 1 always — cat-1 (zero-obs sessions, transcript
 * never read) is structurally OUTSIDE this denominator. Those misses are real
 * but additive, measured separately by decision-capture-audit.
 */
export function readTranscriptUnits(db: Database.Database): TranscriptUnit[] {
  const rows = db
    .prepare(
      `SELECT session_id, json_extract(data,'$.transcriptPath') AS tp
       FROM observations WHERE tp IS NOT NULL`,
    )
    .all() as { session_id: string | null; tp: string }[];
  const byTp = new Map<string, { sessions: Set<string>; obs: number }>();
  for (const r of rows) {
    const e = byTp.get(r.tp) ?? { sessions: new Set<string>(), obs: 0 };
    e.obs += 1;
    if (r.session_id) e.sessions.add(r.session_id);
    byTp.set(r.tp, e);
  }
  const out: TranscriptUnit[] = [];
  for (const [tp, e] of byTp) {
    out.push({
      transcriptPath: tp,
      uuid: path.basename(tp).replace(/\.jsonl$/, ''),
      sessionIds: [...e.sessions],
      obsCount: e.obs,
    });
  }
  return out;
}
