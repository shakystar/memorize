// LLM-judge decision labeler (#99 denominator) — VALIDATION-SUBSET stage.
//
// Produces the DENOMINATOR the structural audit (decision-capture-audit.ts)
// cannot: the decisions/standing-directives actually present in a session's
// conversation. It reads the Claude Code transcript .jsonl, strips it to the
// conversational turns, and asks an LLM judge to label every decision by the
// #99 operational test. It then lays the judge's labels next to the decisions
// memorize actually captured for that session, so the gap is visible per
// transcript.
//
// Per the #99 gate this is run on a SMALL VALIDATION SUBSET first: label one
// transcript, have a human label the same independently, check inter-rater
// agreement BEFORE trusting the judge for a full pass. The judge labels are
// written to scripts/dogfood/labels/<session>.judge.json for that comparison.
//
// The judge runs through the SAME backend the consolidator uses (the `claude`
// CLI on PATH via the user's existing subscription — no API key, local-first),
// mirroring CliConsolidator in src/services/consolidate-service.ts.
//
// Refs issue #99, discussion #98. Read-only over the DB; writes only the
// judge-labels file under scripts/dogfood/labels/.
//
// Usage:
//   tsx scripts/decision-label.ts <project-id|db-path>           # list sessions
//   tsx scripts/decision-label.ts <project-id|db-path> <session> # label one

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const TRANSCRIPT_TAIL_BYTES = 16 * 1024; // mirror consolidate-service (for exposure note)
const JUDGE_TIMEOUT_MS = 300_000;
// Above this much stripped conversational text we'd need chunking; the
// validation subset stays well under it, so we refuse rather than silently
// truncate (a truncated denominator would understate the miss rate).
const MAX_PROMPT_CHARS = 500_000;

function resolveDbPath(arg: string): string {
  if (arg.endsWith('.db') || fs.existsSync(arg)) return arg;
  const root = process.env.MEMORIZE_ROOT ?? path.join(os.homedir(), '.memorize');
  return path.join(root, 'projects', arg, 'memorize.db');
}

// --- transcript -> conversational text --------------------------------------

interface Turn {
  role: 'user' | 'agent';
  text: string;
}

/**
 * Reduce a transcript .jsonl to the conversational turns a decision could be
 * stated in: user message text and assistant *visible* text. Tool inputs,
 * tool results, and assistant thinking are dropped — decisions are
 * communicated in plain turns, and the bulk bytes (#99 cat-2) are tool I/O.
 */
function readConversation(transcriptPath: string): Turn[] {
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

function renderConversation(turns: Turn[]): string {
  return turns
    .map((t) => `### ${t.role === 'user' ? 'USER' : 'AGENT'}\n${t.text}`)
    .join('\n\n');
}

// --- judge ------------------------------------------------------------------

const JUDGE_PROMPT = `You are labeling a development-session transcript for a MEASUREMENT. Your output is the ground-truth denominator for a capture-miss-rate metric — be precise, not generous.

TASK: extract every DECISION or STANDING DIRECTIVE that was actually established in this conversation.

Include an item ONLY if it passes one of these operational tests. The COMMITMENT vs STANDING split is by LIFECYCLE — apply it strictly, it is the most common labeling error:
- COMMITMENT — a specific thing the team committed to DO, which COMPLETES. Once done you would answer "yes, done" and it stops applying. A one-off instruction to do something before/while working ("document these gaps first", "git init the repo", "ship X as a patch") is a COMMITMENT even when phrased like a rule — the test is whether it is discharged by being done, not whether it sounds general.
- STANDING — a standard, preference, fact, or rule that PERSISTS and keeps constraining future work indefinitely, until someone explicitly changes it ("always use the @scoped package name", "dogfood before every publish"). If it can be "finished", it is NOT standing.

EXCLUDE strictly:
- brainstorming, options weighed and dropped, questions, hypotheticals, restated background;
- anything the agent merely PROPOSED that the user did not accept — an agent suggestion counts ONLY if the user confirmed it (an explicit "ok / ㅇㅋ / ㅇㅇ / do it" on that point, or the user then acting on it);
- do NOT double-count: if the user gives one instruction and the agent enumerates the concrete items it covers, count the concrete decisions that carry independent content (e.g. a specific validation rule) — do NOT also emit the umbrella instruction AND a restated general-principle version of it as separate items.

For each item output an object:
  {"type":"commitment"|"standing","statement":"<one-line paraphrase>","quote":"<short verbatim snippet that establishes it>","by":"user"|"agent","accepted":"<how the user confirmed it, or 'unilateral-agent' if they did not>","confidence":<0.0-1.0>}

Output ONLY a JSON array of these objects. No prose, no markdown fences. If there are no qualifying decisions, output [].

TRANSCRIPT:
`;

function runJudge(prompt: string): Promise<string> {
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
    }, JUDGE_TIMEOUT_MS);
    child.stdout.on('data', (c) => (stdout += String(c)));
    child.stderr.on('data', (c) => (stderr += String(c)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`judge timed out after ${JUDGE_TIMEOUT_MS}ms`));
      else if (code !== 0) reject(new Error(`judge exited ${code}: ${stderr.slice(0, 200)}`));
      else resolve(stdout);
    });
    child.stdin.end(prompt);
  });
}

interface Label {
  type: 'commitment' | 'standing';
  statement: string;
  quote: string;
  by: 'user' | 'agent';
  accepted?: string;
  confidence: number;
}

/** Tolerant: pull the first JSON array out of the model's reply. */
function parseLabels(raw: string): Label[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON array in judge output:\n${raw.slice(0, 300)}`);
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error('judge output is not an array');
  return parsed as Label[];
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const projectArg = process.argv[2];
  const sessionArg = process.argv[3];
  if (!projectArg) {
    console.error('Usage: tsx scripts/decision-label.ts <project-id|db-path> [session-id]');
    process.exit(1);
  }
  const dbPath = resolveDbPath(projectArg);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  // session -> transcript (the most recent observation carrying a path)
  const obsRows = db
    .prepare(
      `SELECT session_id, json_extract(data,'$.transcriptPath') AS tp
       FROM observations WHERE tp IS NOT NULL`,
    )
    .all() as { session_id: string; tp: string }[];
  const sessionTranscript = new Map<string, string>();
  for (const r of obsRows) sessionTranscript.set(r.session_id, r.tp); // last wins

  if (!sessionArg) {
    console.log('Sessions with a transcript on disk (smallest first):\n');
    const rows = [...sessionTranscript.entries()]
      .filter(([, tp]) => fs.existsSync(tp))
      .map(([s, tp]) => ({ s, kb: fs.statSync(tp).size / 1024 }))
      .sort((a, b) => a.kb - b.kb);
    for (const r of rows) {
      console.log(`  ${r.kb.toFixed(0).padStart(6)}KB  ${r.s}`);
    }
    console.log('\nPick one as the validation subset:  tsx scripts/decision-label.ts ' + projectArg + ' <session-id>');
    db.close();
    return;
  }

  const transcriptPath = sessionTranscript.get(sessionArg);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    console.error(`No transcript on disk for session ${sessionArg}`);
    process.exit(1);
  }

  // Captured decisions for this session (the numerator side, for comparison).
  const obsToSession = new Map<string, string>();
  for (const r of db.prepare('SELECT id, session_id FROM observations').all() as {
    id: string;
    session_id: string;
  }[]) {
    obsToSession.set(r.id, r.session_id);
  }
  const captured: string[] = [];
  for (const m of db
    .prepare("SELECT json_extract(data,'$.text') AS text, json_extract(data,'$.sourceObservationIds') AS ids FROM memories WHERE kind='decision'")
    .all() as { text: string | null; ids: string | null }[]) {
    const ids = (JSON.parse(m.ids ?? '[]') as string[]) ?? [];
    if (ids.some((id) => obsToSession.get(id) === sessionArg) && m.text) {
      captured.push(m.text);
    }
  }
  db.close();

  const turns = readConversation(transcriptPath);
  const conversation = renderConversation(turns);
  const txKb = (fs.statSync(transcriptPath).size / 1024).toFixed(0);
  console.log(`# Decision labeling — session ${sessionArg}`);
  console.log(`  transcript:   ${transcriptPath} (${txKb}KB raw)`);
  console.log(`  turns kept:   ${turns.length} (user + agent text; tool I/O & thinking stripped)`);
  console.log(`  judge input:  ${(conversation.length / 1024).toFixed(0)}KB of conversation`);
  console.log(`  raw outside the ${(TRANSCRIPT_TAIL_BYTES / 1024).toFixed(0)}KB tail the extractor saw: ${((fs.statSync(transcriptPath).size - TRANSCRIPT_TAIL_BYTES) / 1024).toFixed(0)}KB`);

  if (conversation.length > MAX_PROMPT_CHARS) {
    console.error(
      `\nConversation (${conversation.length} chars) exceeds the single-call limit (${MAX_PROMPT_CHARS}). ` +
        'Chunking is the full-pass concern; pick a smaller transcript for the validation subset.',
    );
    process.exit(1);
  }

  console.log('\nRunning judge (claude CLI)…');
  const raw = await runJudge(JUDGE_PROMPT + conversation);
  const labels = parseLabels(raw);

  const outDir = path.join('scripts', 'dogfood', 'labels');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${sessionArg}.judge.json`);
  fs.writeFileSync(outFile, JSON.stringify(labels, null, 2) + '\n');

  console.log(`\n## Judge-labeled decisions in conversation (denominator): ${labels.length}\n`);
  for (const l of labels) {
    console.log(
      `  [${l.type}/${l.by}${l.accepted ? ` accepted:${l.accepted}` : ''} ${l.confidence}] ${l.statement}`,
    );
    console.log(`      "${l.quote.replace(/\s+/g, ' ').slice(0, 100)}"`);
  }

  console.log(`\n## Decisions memorize actually captured for this session (numerator): ${captured.length}\n`);
  for (const c of captured) {
    console.log(`  - ${c.replace(/\s+/g, ' ').slice(0, 100)}`);
  }

  const provisional =
    labels.length > 0 ? (1 - captured.length / labels.length) * 100 : 0;
  console.log('\n## Provisional (count-only) miss indication');
  console.log(
    `  ${captured.length} captured / ${labels.length} present  ->  ~${provisional.toFixed(0)}% not captured`,
  );
  console.log('  PROVISIONAL ONLY: this is a raw count ratio, not a semantic match, and the');
  console.log('  judge is NOT YET human-validated. Next: a human labels the same transcript');
  console.log('  independently; compare for inter-rater agreement before trusting the judge.');
  console.log(`\n  judge labels written: ${outFile}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
