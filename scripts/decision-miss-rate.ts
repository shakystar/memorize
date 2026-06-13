// #99 decision miss-rate — the full measurement (semantic matcher + classifier).
//
// Closes the pipeline the structural audit (decision-capture-audit.ts) and the
// judge (decision-label.ts) set up. For every session with a transcript on
// disk it obtains the judge's PRESENT decisions (cached labels, or runs the
// judge), then computes the real metric pre-registered in #99:
//
//   miss_rate = 1 - (present decisions semantically matched in the captured set
//                    / present decisions)
//
// Two things make this honest where a per-session count ratio is not:
//
//   1. SEMANTIC MATCH AGAINST THE WHOLE CAPTURED SET. A decision captured in
//      one session can be the consolidation of a discussion held in another;
//      captured vs present sets are disjoint by topic, so each present decision
//      is matched (by the same local LLM) against EVERY captured decision, not
//      counted within its own session.
//
//   2. EACH MISS IS LOCATED IN THE TRANSCRIPT and classified by the #99
//      taxonomy from where its quote actually sits:
//        cat-1  the session captured ZERO observations -> transcript never read
//        cat-2  the quote lies OUTSIDE the last 16KB the extractor was handed
//        cat-3  the quote is INSIDE that tail (seen) yet was not extracted
//      cat-1+cat-2 are STRUCTURAL (the bytes are never seen); cat-3 is an
//      EXTRACTION/CLASSIFICATION failure — the part a better extractor (the
//      #104 Q1 authority-detection work) could recover.
//
// As a secondary cut each present decision is tagged conversation-only vs
// tool-anchored by whether a tool_use/tool_result record sits near its quote —
// a heuristic proxy for whether the capture path had any anchor at all there.
//
// CAVEAT (radical transparency, #101): the only real corpus on this machine is
// memorize dogfooding itself — self-referential and meta-heavy (lots of
// discussion ABOUT memory). The authoritative cross-project number needs the
// #98 private corpus, which lives elsewhere; run this same tool there.
//
// Refs issue #99, discussion #98. Read-only over the DB; reuses/writes judge
// labels under scripts/dogfood/labels/.
//
// Usage: tsx scripts/decision-miss-rate.ts <project-id|db-path> [--fresh]

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  type CapturedDecision,
  JUDGE_PROMPT,
  type Label,
  MAX_PROMPT_CHARS,
  parseJsonArray,
  readCapturedDecisions,
  readConversation,
  readTranscriptUnits,
  renderConversation,
  resolveDbPath,
  runCli,
  TRANSCRIPT_TAIL_BYTES,
  type TranscriptUnit,
} from './decision-lib.ts';

const LABELS_DIR = path.join('scripts', 'dogfood', 'labels');

// --- transcript records with byte offsets (for locating a quote) ------------

interface Record {
  startByte: number;
  isConv: boolean; // carries user/assistant visible text
  isTool: boolean; // carries tool_use or tool_result
  text: string; // concatenated visible text (normalized whitespace)
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Parse a transcript .jsonl into ordered records, each with its byte offset. */
function readRecords(transcriptPath: string): { records: Record[]; sizeBytes: number } {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const sizeBytes = Buffer.byteLength(raw, 'utf8');
  const records: Record[] = [];
  let offset = 0;
  for (const line of raw.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for the \n
    const startByte = offset;
    offset += lineBytes;
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = obj as { type?: string; message?: { content?: unknown } };
    let isConv = false;
    let isTool = false;
    const texts: string[] = [];
    const content = rec.message?.content;
    if (rec.type === 'user') {
      if (typeof content === 'string') {
        isConv = true;
        texts.push(content);
      } else if (Array.isArray(content)) {
        for (const b of content as Array<{ type?: string; text?: string }>) {
          if (b.type === 'text' && b.text) {
            isConv = true;
            texts.push(b.text);
          } else if (b.type === 'tool_result') {
            isTool = true;
          }
        }
      }
    } else if (rec.type === 'assistant' && Array.isArray(content)) {
      for (const b of content as Array<{ type?: string; text?: string }>) {
        if (b.type === 'text' && b.text) {
          isConv = true;
          texts.push(b.text);
        } else if (b.type === 'tool_use') {
          isTool = true;
        }
      }
    }
    if (isConv || isTool) {
      records.push({ startByte, isConv, isTool, text: normalize(texts.join(' ')) });
    }
  }
  return { records, sizeBytes };
}

// cat-1 (zero-obs sessions) is structurally outside this denominator — a
// transcript is only here because an observation carried its path, so obsCount
// is always >= 1. cat-1 misses are real but additive (decision-capture-audit).
type MissCat = 'cat-2' | 'cat-3' | 'unlocatable';

interface Located {
  recordIndex: number;
  startByte: number;
  toolAnchored: boolean;
}

/** Find the conversational record whose text contains the quote. */
function locate(records: Record[], quote: string): Located | null {
  const q = normalize(quote);
  // Try the full quote, then progressively shorter prefixes — judges sometimes
  // lightly paraphrase the tail of a quote, but the head is usually verbatim.
  // Floor at 6 so short-but-distinctive confirmations ("ㅇㅇ 배포해") still match;
  // the judge prompt forbids bare 1-2 char tokens that would be unlocatable.
  const probes = [q, q.slice(0, 80), q.slice(0, 40), q.slice(0, 20)].filter((p) => p.length >= 6);
  for (const probe of probes) {
    const idx = records.findIndex((r) => r.isConv && r.text.includes(probe));
    const hit = idx !== -1 ? records[idx] : undefined;
    if (hit) {
      // tool-anchored if a tool record sits within a small window either side.
      let toolAnchored = false;
      for (let j = Math.max(0, idx - 2); j <= Math.min(records.length - 1, idx + 2); j++) {
        if (records[j]?.isTool) {
          toolAnchored = true;
          break;
        }
      }
      return { recordIndex: idx, startByte: hit.startByte, toolAnchored };
    }
  }
  return null;
}

// --- semantic matcher -------------------------------------------------------

interface MatchResult {
  present: number;
  match: number | null; // index into captured set, or null
  confidence: number;
}

function matcherPrompt(present: Label[], captured: CapturedDecision[]): string {
  const presentList = present
    .map((l, i) => `${i}. [${l.type}] ${l.statement}`)
    .join('\n');
  const capturedList = captured.map((c, i) => `${i}. ${normalize(c.text)}`).join('\n');
  return `You are matching DECISIONS for a measurement. Below are PRESENT decisions (extracted from one session's conversation) and the FULL SET of decisions a memory system actually CAPTURED across all sessions of this project.

For each PRESENT decision, decide whether its substance is represented by ANY captured decision — a semantic match, not string equality. A captured decision that states the same commitment/standing rule (even paraphrased, even merged with others, even captured from a different session) COUNTS as a match. Partial topical overlap that misses the actual decision does NOT count.

Be strict: when unsure, treat it as NO match (null). A false match would hide a real capture miss.

PRESENT decisions:
${presentList}

CAPTURED decisions (the whole set):
${capturedList}

Output ONLY a JSON array, one object per PRESENT decision, in order:
  {"present":<present index>,"match":<captured index or null>,"confidence":<0.0-1.0>}
No prose, no markdown fences.`;
}

async function matchSession(present: Label[], captured: CapturedDecision[]): Promise<MatchResult[]> {
  if (present.length === 0) return [];
  const raw = await runCli(matcherPrompt(present, captured));
  const results = parseJsonArray<MatchResult>(raw);
  // Defend against a short/over-long reply: index by `present` field.
  const byIndex = new Map<number, MatchResult>();
  for (const r of results) byIndex.set(r.present, r);
  return present.map((_, i) => byIndex.get(i) ?? { present: i, match: null, confidence: 0 });
}

// --- judge labels (cached, keyed by transcript uuid) ------------------------

async function getLabels(unit: TranscriptUnit, fresh: boolean): Promise<Label[] | { error: string }> {
  const file = path.join(LABELS_DIR, `${unit.uuid}.judge.json`);
  if (!fresh && fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Label[];
  }
  // Migrate a legacy session-keyed cache (this transcript's owning session) to
  // the uuid name, so the keying fix does not throw away earlier judge work.
  if (!fresh) {
    for (const sid of unit.sessionIds) {
      const legacy = path.join(LABELS_DIR, `${sid}.judge.json`);
      if (fs.existsSync(legacy)) {
        const labels = JSON.parse(fs.readFileSync(legacy, 'utf8')) as Label[];
        fs.writeFileSync(file, JSON.stringify(labels, null, 2) + '\n');
        return labels;
      }
    }
  }
  const conversation = renderConversation(readConversation(unit.transcriptPath));
  if (conversation.length > MAX_PROMPT_CHARS) {
    return { error: `conversation ${(conversation.length / 1024).toFixed(0)}KB exceeds single-call limit` };
  }
  const raw = await runCli(JUDGE_PROMPT + conversation);
  const labels = parseJsonArray<Label>(raw);
  fs.mkdirSync(LABELS_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(labels, null, 2) + '\n');
  return labels;
}

// --- main -------------------------------------------------------------------

interface PresentDecision {
  unit: string;
  label: Label;
  matched: boolean;
  missCat: MissCat | undefined;
  toolAnchored: boolean;
}

async function main(): Promise<void> {
  const projectArg = process.argv[2];
  const fresh = process.argv.includes('--fresh');
  if (!projectArg) {
    console.error('Usage: tsx scripts/decision-miss-rate.ts <project-id|db-path> [--fresh]');
    process.exit(1);
  }
  const dbPath = resolveDbPath(projectArg);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const captured = readCapturedDecisions(db);
  const allUnits = readTranscriptUnits(db);
  db.close();

  const units = allUnits
    .filter((u) => fs.existsSync(u.transcriptPath))
    .map((u) => ({ ...u, kb: fs.statSync(u.transcriptPath).size / 1024 }))
    .sort((a, b) => a.kb - b.kb);

  console.log(`# Decision miss-rate (#99) — ${units.length} transcript-bearing units`);
  console.log(`  db:               ${dbPath}`);
  console.log(`  captured set:     ${captured.length} kind=decision memories (matched against in full)`);
  console.log(`  tail seen:        last ${TRANSCRIPT_TAIL_BYTES / 1024}KB of each transcript`);
  console.log(`  judge labels:     ${fresh ? 'FRESH (re-running judge)' : 'cached where available'}\n`);

  interface UnitResult {
    decisions: PresentDecision[];
    skip?: { u: string; reason: string };
  }

  // One transcript's full pipeline: judge labels (cached) -> semantic match ->
  // locate + classify each miss. Independent across units, so these run with
  // bounded concurrency below (judge/matcher calls are the slow part).
  async function processUnit(unit: TranscriptUnit): Promise<UnitResult> {
    // A single unit's judge/matcher call timing out (large transcripts) must
    // NOT sink the whole run — degrade it to a reported skip and keep going, so
    // the aggregate still reflects every unit that did complete (#101).
    try {
      return await runUnit(unit);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.log(`  · ${unit.uuid}  SKIP (${reason})`);
      return { decisions: [], skip: { u: unit.uuid, reason } };
    }
  }

  const label = (unit: TranscriptUnit): string =>
    `${unit.uuid.slice(0, 8)} [${unit.sessionIds.length ? unit.sessionIds.map((s) => s.replace(/^session_/, '')).join(',') : 'null-session'}]`;

  async function runUnit(unit: TranscriptUnit): Promise<UnitResult> {
    const labelsOrErr = await getLabels(unit, fresh);
    if ('error' in labelsOrErr) {
      console.log(`  · ${label(unit)}  SKIP (${labelsOrErr.error})`);
      return { decisions: [], skip: { u: unit.uuid, reason: labelsOrErr.error } };
    }
    const labels = labelsOrErr;
    if (labels.length === 0) {
      console.log(`  · ${label(unit)}  0 present`);
      return { decisions: [] };
    }
    const matches = await matchSession(labels, captured);
    const { records, sizeBytes } = readRecords(unit.transcriptPath);
    const tailStart = Math.max(0, sizeBytes - TRANSCRIPT_TAIL_BYTES);

    const decisions: PresentDecision[] = [];
    let missCount = 0;
    labels.forEach((lbl, i) => {
      const matched = (matches[i]?.match ?? null) !== null;
      const loc = locate(records, lbl.quote);
      let missCat: MissCat | undefined;
      if (!matched) {
        missCount += 1;
        // obsCount is always >= 1 here, so cat-1 cannot apply (see MissCat).
        if (!loc) missCat = 'unlocatable';
        else if (loc.startByte < tailStart) missCat = 'cat-2';
        else missCat = 'cat-3';
      }
      decisions.push({
        unit: unit.uuid,
        label: lbl,
        matched,
        missCat,
        toolAnchored: loc?.toolAnchored ?? false,
      });
    });
    console.log(`  · ${label(unit)}  ${labels.length} present, ${labels.length - missCount} matched, ${missCount} miss`);
    return { decisions };
  }

  // Bounded-parallel map: units are independent; the slow part is the CLI
  // judge/matcher calls, so run CONCURRENCY at a time rather than one-by-one.
  // Kept LOW (2): several heavy judge calls at once contend for the one local
  // Opus and each slows past its timeout — the failure that sank the first
  // parallel run. Two in flight keeps throughput up without starving the big
  // transcripts in the tail of the queue.
  const CONCURRENCY = 2;
  const queue = [...units];
  const results: UnitResult[] = [];
  async function worker(): Promise<void> {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      results.push(await processUnit(next));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));

  const all: PresentDecision[] = results.flatMap((r) => r.decisions);
  const skipped = results.map((r) => r.skip).filter((x): x is { u: string; reason: string } => Boolean(x));

  // --- aggregate ------------------------------------------------------------

  const present = all.length;
  const matched = all.filter((d) => d.matched).length;
  const missed = present - matched;
  const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(0)}%` : '-');

  console.log(`\n## Miss-rate\n`);
  console.log(`  present decisions:   ${present}`);
  console.log(`  semantically matched:${String(matched).padStart(4)}  (${pct(matched, present)} captured)`);
  console.log(`  MISSED:              ${String(missed).padStart(4)}  (${pct(missed, present)} miss-rate)`);

  // by lifecycle
  const cut = (pred: (d: PresentDecision) => boolean, label: string) => {
    const sub = all.filter(pred);
    const m = sub.filter((d) => !d.matched).length;
    console.log(`  ${label.padEnd(22)} ${String(m).padStart(3)} / ${String(sub.length).padStart(3)} miss  (${pct(m, sub.length)})`);
  };
  console.log(`\n## By decision type\n`);
  cut((d) => d.label.type === 'standing', 'standing directives');
  cut((d) => d.label.type === 'commitment', 'commitments');
  console.log(`\n## By anchor (heuristic)\n`);
  cut((d) => !d.toolAnchored, 'conversation-only');
  cut((d) => d.toolAnchored, 'tool-anchored');

  // miss taxonomy — locatable misses only (unlocatable is reported separately,
  // never folded into structural/extraction so the split stays trustworthy).
  const misses = all.filter((d) => !d.matched);
  const catCount = (c: MissCat) => misses.filter((d) => d.missCat === c).length;
  const located = catCount('cat-2') + catCount('cat-3');
  console.log(`\n## Miss taxonomy (where the ${missed} misses sit)\n`);
  console.log(`  cat-2  outside the 16KB tail:            ${String(catCount('cat-2')).padStart(3)}  (${pct(catCount('cat-2'), located)} of located)`);
  console.log(`  cat-3  in tail, seen, not extracted:     ${String(catCount('cat-3')).padStart(3)}  (${pct(catCount('cat-3'), located)} of located)`);
  console.log(`  unlocatable (quote not found in file):   ${String(catCount('unlocatable')).padStart(3)}  (${pct(catCount('unlocatable'), missed)} of all misses)`);
  console.log(`\n  Of the ${located} LOCATED misses:`);
  console.log(`    STRUCTURAL (cat-2, bytes never seen):   ${catCount('cat-2')} / ${located}  (${pct(catCount('cat-2'), located)})`);
  console.log(`    EXTRACTION (cat-3, seen but dropped):   ${catCount('cat-3')} / ${located}  (${pct(catCount('cat-3'), located)})`);
  console.log(`    -> cat-3 is the slice a better extractor (#104 Q1 authority`);
  console.log(`       detection) could recover; cat-2 needs the capture-path fix.`);
  if (catCount('unlocatable') > 0) {
    console.log(`\n  NOTE: ${catCount('unlocatable')} miss(es) unlocatable — quote not found in the`);
    console.log(`  transcript (judge paraphrase, or a transcript not on disk). These are`);
    console.log(`  NOT assigned a category; a high count means the split is under-powered.`);
  }
  console.log(`\n  BLIND SPOT (cat-1): zero-observation sessions are absent from this`);
  console.log(`  denominator entirely (no transcript anchor -> never labeled), so their`);
  console.log(`  decisions cannot appear as misses here. That population is additive and`);
  console.log(`  measured separately by decision-capture-audit (~40% of sessions).`);

  if (skipped.length > 0) {
    console.log(`\n## Skipped (no silent caps, #101)\n`);
    for (const sk of skipped) console.log(`  ${sk.u}: ${sk.reason}`);
    console.log(`  -> these transcripts are excluded from the denominator above; their`);
    console.log(`     decisions are uncounted, so the true miss-rate may differ.`);
  }

  console.log(`\n## Caveat\n`);
  console.log(`  Self-referential corpus: this is memorize dogfooding memorize, meta-heavy.`);
  console.log(`  The authoritative cross-project number needs the #98 private corpus`);
  console.log(`  (not on this machine). Run this same tool there for the real figure.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
