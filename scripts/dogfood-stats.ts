// Read-only dogfooding stats over a memorize project DB.
// Reports how the capture -> consolidate -> inject loop performed.
// Refs discussion #98.
//
// Usage: tsx scripts/dogfood-stats.ts <path-to-memorize.db | project-id>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

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

function truncate(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: tsx scripts/dogfood-stats.ts <path-to-memorize.db | project-id>');
  process.exit(1);
}

const dbPath = resolveDbPath(arg);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// 1. Project + time span
const title =
  (db
    .prepare(
      "SELECT json_extract(payload, '$.title') AS title FROM events WHERE type = 'project.created' ORDER BY seq LIMIT 1",
    )
    .get() as { title: string | null } | undefined)?.title ??
  (db.prepare("SELECT json_extract(data, '$.title') AS title FROM projects LIMIT 1").get() as
    | { title: string | null }
    | undefined)?.title ??
  '(unknown)';
const span = db
  .prepare('SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM events')
  .get() as { first: string | null; last: string | null };
const sessionCount = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;

console.log(`# Dogfood stats: ${title}`);
console.log(`\n  db:        ${dbPath}`);
console.log(`  events:    ${span.first ?? '-'} .. ${span.last ?? '-'}`);
console.log(`  sessions:  ${sessionCount}`);

// 2. Events by type
heading('Events by type');
const eventRows = db
  .prepare('SELECT type, COUNT(*) AS c FROM events GROUP BY type ORDER BY c DESC')
  .all() as { type: string; c: number }[];
table(eventRows.map((r) => [r.type, String(r.c)]));

// 3. Observations
const obsTotal = (db.prepare('SELECT COUNT(*) AS c FROM observations').get() as { c: number }).c;
heading(`Observations (total ${obsTotal})`);
const obsBySignal = db
  .prepare('SELECT signal, COUNT(*) AS c FROM observations GROUP BY signal ORDER BY c DESC')
  .all() as { signal: string; c: number }[];
console.log('  By signal:');
table(obsBySignal.map((r) => [r.signal, String(r.c)]));
console.log('\n  Per day:');
const obsPerDay = db
  .prepare(
    'SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS c FROM observations GROUP BY day ORDER BY day',
  )
  .all() as { day: string; c: number }[];
table(obsPerDay.map((r) => [r.day, String(r.c)]));

// 4. Memories
const memTotal = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
heading(`Memories (total ${memTotal})`);
const memByKind = db
  .prepare(
    'SELECT kind, COUNT(*) AS c, ROUND(AVG(salience), 3) AS avg_salience FROM memories GROUP BY kind ORDER BY c DESC',
  )
  .all() as { kind: string; c: number; avg_salience: number }[];
console.log('  By kind:');
table([
  ['kind', 'count', 'avg salience'],
  ...memByKind.map((r) => [r.kind, String(r.c), String(r.avg_salience)]),
]);
const lifecycle = db
  .prepare(
    `SELECT
       SUM(CASE WHEN superseded_by IS NOT NULL THEN 1 ELSE 0 END) AS superseded,
       SUM(CASE WHEN invalid_at IS NOT NULL THEN 1 ELSE 0 END) AS invalidated,
       SUM(CASE WHEN deduped_by IS NOT NULL THEN 1 ELSE 0 END) AS deduped
     FROM memories`,
  )
  .get() as { superseded: number; invalidated: number; deduped: number };
console.log('\n  Lifecycle:');
table([
  ['superseded', String(lifecycle.superseded)],
  ['invalidated', String(lifecycle.invalidated)],
  ['deduped', String(lifecycle.deduped)],
]);

// 5. Injection
const injection = db
  .prepare(
    'SELECT COALESCE(SUM(injection_count), 0) AS total, SUM(CASE WHEN injection_count > 0 THEN 1 ELSE 0 END) AS injected FROM memories',
  )
  .get() as { total: number; injected: number };
heading('Injection');
console.log(`  Total injections:        ${injection.total}`);
console.log(`  Memories injected >= 1x: ${injection.injected} / ${memTotal}`);
console.log('\n  Top 5 by injection_count:');
const topInjected = db
  .prepare(
    `SELECT kind, salience, injection_count, json_extract(data, '$.text') AS text
     FROM memories ORDER BY injection_count DESC, salience DESC LIMIT 5`,
  )
  .all() as { kind: string; salience: number; injection_count: number; text: string | null }[];
table([
  ['inj', 'kind', 'salience', 'text'],
  ...topInjected.map((r) => [
    String(r.injection_count),
    r.kind,
    String(r.salience),
    truncate(r.text ?? ''),
  ]),
]);

// 6. Observation -> memory coverage
const covered = (db
  .prepare(
    `SELECT COUNT(DISTINCT je.value) AS c
     FROM memories m, json_each(json_extract(m.data, '$.sourceObservationIds')) je
     WHERE je.value IN (SELECT id FROM observations)`,
  )
  .get() as { c: number }).c;
heading('Observation -> memory coverage');
const pct = obsTotal > 0 ? ((covered / obsTotal) * 100).toFixed(1) : '0.0';
console.log(`  ${covered} / ${obsTotal} observations consolidated into memories (${pct}%)`);

// 7. Consolidation meta
heading('Consolidation meta');
for (const key of [
  'cls_consolidate_last_attempt',
  'cls_consolidate_threshold_trigger',
  'cls_consolidate_watermark',
]) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) {
    console.log(`  ${key}: (not set)`);
    continue;
  }
  let pretty = row.value;
  try {
    pretty = JSON.stringify(JSON.parse(row.value), null, 2);
  } catch {
    // not JSON, print raw
  }
  console.log(`  ${key}:`);
  console.log(
    pretty
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n'),
  );
}

db.close();
