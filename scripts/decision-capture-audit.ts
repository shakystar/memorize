// Read-only structural audit of the decision-capture path (#99).
//
// The DETERMINISTIC substrate of the decision miss-rate measurement
// pre-registered in issue #99. It computes, with NO LLM and NO labeling,
// the *structural miss capacity* of the capture path — i.e. how much of a
// session's conversation the consolidator can never see — so the expensive
// LLM-judge labeling pass (the denominator: decisions actually present in
// the conversation) can be scoped against real populations first.
//
// It maps the #99 miss taxonomy onto what the DB + transcript files reveal:
//   cat-1 (no anchor)      -> sessions with ZERO captured observations; the
//                             transcript is never read (consolidate-service
//                             reads it only via an observation's transcriptPath).
//   cat-2 (outside tail)   -> bytes beyond the last TRANSCRIPT_TAIL_BYTES of a
//                             transcript; the extractor only ever sees the tail.
//   cat-3 (seen, not kept) -> NOT measurable here; needs the LLM-judge pass.
//
// This script measures capacity, not the miss rate itself. The denominator
// (real decisions in conversation) and the precise cat-1/2/3 split require the
// labeling stage gated on a human-validated judge subset (#99). See footer.
//
// Refs issue #99, discussion #98. Read-only; never writes.
//
// Usage: tsx scripts/decision-capture-audit.ts <path-to-memorize.db | project-id>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

// Mirrors TRANSCRIPT_TAIL_BYTES in src/services/consolidate-service.ts — the
// only slice of a transcript the extractor is ever handed. Kept in sync by the
// docs-consistency spirit; if the source constant moves, update here.
const TRANSCRIPT_TAIL_BYTES = 16 * 1024;

function resolveDbPath(arg: string): string {
  if (arg.endsWith('.db') || fs.existsSync(arg)) {
    return arg;
  }
  const root = process.env.MEMORIZE_ROOT ?? path.join(os.homedir(), '.memorize');
  return path.join(root, 'projects', arg, 'memorize.db');
}

function heading(title: string): void {
  console.log(`\n## ${title}\n`);
}

function table(rows: string[][]): void {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  for (const row of rows) {
    console.log(
      '  ' + row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd(),
    );
  }
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '-';
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)}KB`;
}

const arg = process.argv[2];
if (!arg) {
  console.error(
    'Usage: tsx scripts/decision-capture-audit.ts <path-to-memorize.db | project-id>',
  );
  process.exit(1);
}

const dbPath = resolveDbPath(arg);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

interface ObsRow {
  id: string;
  session_id: string;
  signal: string;
  transcriptPath: string | null;
}
interface MemRow {
  kind: string;
  text: string | null;
  sourceObservationIds: string;
}

// --- load -------------------------------------------------------------------

const sessions = db
  .prepare("SELECT id, json_extract(data, '$.startedAt') AS startedAt FROM sessions")
  .all() as { id: string; startedAt: string | null }[];

const observations = db
  .prepare(
    `SELECT id, session_id,
            signal,
            json_extract(data, '$.transcriptPath') AS transcriptPath
     FROM observations`,
  )
  .all() as ObsRow[];

const memories = db
  .prepare(
    `SELECT kind,
            json_extract(data, '$.text') AS text,
            json_extract(data, '$.sourceObservationIds') AS sourceObservationIds
     FROM memories`,
  )
  .all() as MemRow[];

// obsId -> sessionId, for mapping memories back to the session they distilled.
const obsToSession = new Map<string, string>();
for (const o of observations) obsToSession.set(o.id, o.session_id);

const obsBySession = new Map<string, ObsRow[]>();
for (const o of observations) {
  const list = obsBySession.get(o.session_id) ?? [];
  list.push(o);
  obsBySession.set(o.session_id, list);
}

// decisions consolidated per session (numerator basis), via sourceObservationIds.
const decisionsBySession = new Map<string, number>();
let decisionsTotal = 0;
let decisionsOrphan = 0; // kind=decision whose source obs we can't resolve to a session
for (const m of memories) {
  if (m.kind !== 'decision') continue;
  decisionsTotal += 1;
  const ids = (JSON.parse(m.sourceObservationIds ?? '[]') as string[]) ?? [];
  const sessionIds = new Set(
    ids.map((id) => obsToSession.get(id)).filter((s): s is string => Boolean(s)),
  );
  if (sessionIds.size === 0) decisionsOrphan += 1;
  for (const s of sessionIds) {
    decisionsBySession.set(s, (decisionsBySession.get(s) ?? 0) + 1);
  }
}

const span = db
  .prepare('SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM events')
  .get() as { first: string | null; last: string | null };

const title =
  (db
    .prepare("SELECT json_extract(data, '$.title') AS title FROM projects LIMIT 1")
    .get() as { title: string | null } | undefined)?.title ?? '(unknown)';

console.log(`# Decision-capture audit: ${title}`);
console.log(`\n  db:        ${dbPath}`);
console.log(`  events:    ${span.first ?? '-'} .. ${span.last ?? '-'}`);
console.log(`  sessions:  ${sessions.length}`);
console.log(`  tail:      last ${kb(TRANSCRIPT_TAIL_BYTES)} of each transcript (the only slice the extractor sees)`);

// --- 1. capture signal distribution (the headline 1/N) ----------------------

heading('Capture signal distribution');
const bySignal = db
  .prepare('SELECT signal, COUNT(*) AS c FROM observations GROUP BY signal ORDER BY c DESC')
  .all() as { signal: string; c: number }[];
const obsTotal = observations.length;
table([
  ['signal', 'count', 'share'],
  ...bySignal.map((r) => [r.signal, String(r.c), pct(r.c, obsTotal)]),
]);
const decisionKeyword = bySignal.find((r) => r.signal === 'decision-keyword')?.c ?? 0;
console.log(
  `\n  decision-keyword fired ${decisionKeyword} / ${obsTotal} observations (${pct(decisionKeyword, obsTotal)})`,
);
console.log(
  '  NOTE: decision-keyword fires on tool input text (e.g. a branch name containing',
);
console.log(
  '  "decision"), so even this count is an upper bound on real captured decisions.',
);

// --- 2. per-session structural exposure -------------------------------------

heading('Per-session structural exposure');

interface SessionAudit {
  id: string;
  obs: number;
  decisionKw: number;
  transcript: string | null;
  exists: boolean;
  size: number;
  outsideTail: number;
  decisions: number;
}

const audits: SessionAudit[] = sessions
  .map((s) => {
    const obs = obsBySession.get(s.id) ?? [];
    const decisionKw = obs.filter((o) => o.signal === 'decision-keyword').length;
    // The transcript the consolidator would reach for this session: any obs
    // carrying a transcriptPath (it uses the most recent such).
    const tp = obs.find((o) => o.transcriptPath)?.transcriptPath ?? null;
    let exists = false;
    let size = 0;
    if (tp && fs.existsSync(tp)) {
      exists = true;
      size = fs.statSync(tp).size;
    }
    const outsideTail = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    return {
      id: s.id,
      obs: obs.length,
      decisionKw,
      transcript: tp,
      exists,
      size,
      outsideTail,
      decisions: decisionsBySession.get(s.id) ?? 0,
    };
  })
  // Order: most exposed first (largest unseen tail), then by obs count.
  .sort((a, b) => b.outsideTail - a.outsideTail || b.obs - a.obs);

table([
  ['session', 'obs', 'dec-kw', 'transcript', 'size', 'outside-tail', 'decisions'],
  ...audits.map((a) => [
    a.id.replace(/^session_/, ''),
    String(a.obs),
    String(a.decisionKw),
    a.transcript ? (a.exists ? 'yes' : 'MISSING') : 'none',
    a.exists ? kb(a.size) : '-',
    a.exists ? `${kb(a.outsideTail)} (${pct(a.outsideTail, a.size)})` : '-',
    String(a.decisions),
  ]),
]);

// --- 3. structural miss-capacity summary ------------------------------------

heading('Structural miss capacity (the #99 taxonomy)');

const zeroObsSessions = audits.filter((a) => a.obs === 0);
// Aggregate cat-2 over DISTINCT transcript paths: sessions can share one
// transcript (multiple actors/sessions on the same file), so summing per
// session would double-count those bytes.
const distinctTranscripts = new Map<string, number>();
for (const a of audits) {
  if (a.exists && a.transcript) distinctTranscripts.set(a.transcript, a.size);
}
const totalTranscriptBytes = [...distinctTranscripts.values()].reduce((n, sz) => n + sz, 0);
const totalOutsideTail = [...distinctTranscripts.values()].reduce(
  (n, sz) => n + Math.max(0, sz - TRANSCRIPT_TAIL_BYTES),
  0,
);
const transcriptsMissing = audits.filter((a) => a.transcript && !a.exists).length;

console.log('  cat-1  no anchor (transcript never read):');
console.log(
  `         ${zeroObsSessions.length} / ${sessions.length} sessions captured ZERO observations (${pct(zeroObsSessions.length, sessions.length)})`,
);
console.log(
  '         -> any decision made in these sessions is structurally invisible.',
);
console.log('\n  cat-2  outside tail window:');
console.log(
  `         ${kb(totalOutsideTail)} / ${kb(totalTranscriptBytes)} of transcript bytes lie beyond the last ${kb(TRANSCRIPT_TAIL_BYTES)} (${pct(totalOutsideTail, totalTranscriptBytes)}) across ${distinctTranscripts.size} distinct transcript(s)`,
);
console.log(
  '         -> indicative ceiling: real coverage is higher because multiple',
);
console.log(
  '            consolidation boundaries each read a different (growing) tail slice,',
);
console.log(
  '            but the per-boundary structural bound is this small.',
);
console.log('\n  cat-3  seen but not extracted:');
console.log('         NOT measurable here — requires the LLM-judge labeling pass.');

if (transcriptsMissing > 0) {
  console.log(
    `\n  WARNING: ${transcriptsMissing} session(s) reference a transcript that no longer exists on disk`,
  );
  console.log('           — the denominator for those cannot be reconstructed retrospectively.');
}

// --- 4. numerator basis -----------------------------------------------------

heading('Numerator basis (decisions captured in DB)');
console.log(`  kind=decision memories:           ${decisionsTotal}`);
console.log(`  mappable to a session:            ${decisionsTotal - decisionsOrphan}`);
console.log(`  orphan (no resolvable session):   ${decisionsOrphan}`);

// --- footer: what this does NOT measure -------------------------------------

heading('What this does NOT measure (the gated next stage)');
console.log('  This is the deterministic substrate only. To compute the actual');
console.log('  miss_rate = 1 - (decisions captured / decisions present in conversation),');
console.log('  the DENOMINATOR must be produced by an LLM-judge labeling pass over the');
console.log('  transcripts above, scoped by the #99 operational test (commitment /');
console.log('  standing directive), and the judge must be validated against a');
console.log('  human-labeled subset BEFORE the full pass is trusted (#99 gate).');
console.log('  Only then can each miss be classified cat-1 / cat-2 / cat-3.');

db.close();
