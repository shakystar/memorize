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

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  JUDGE_PROMPT,
  type Label,
  MAX_PROMPT_CHARS,
  parseJsonArray,
  readConversation,
  renderConversation,
  resolveDbPath,
  runCli,
  TRANSCRIPT_TAIL_BYTES,
} from './decision-lib.ts';

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
  const raw = await runCli(JUDGE_PROMPT + conversation);
  const labels = parseJsonArray<Label>(raw);

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
