#!/usr/bin/env node
// Aggregate stress-run results into a per-scenario summary + failure buckets.
// Usage: node aggregate.mjs <resultsRoot> [<resultsRoot2> ...]
//   e.g. node aggregate.mjs results/win \\wsl$\Ubuntu\home\me\memorize-stress\results

import fs from 'node:fs';
import path from 'node:path';

const roots = process.argv.slice(2);
if (!roots.length) { console.error('usage: node aggregate.mjs <resultsRoot>...'); process.exit(2); }

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

const runs = [];
for (const root of roots) {
  if (!fs.existsSync(root)) { console.error(`skip (not found): ${root}`); continue; }
  for (const name of fs.readdirSync(root).filter(n => n.startsWith('run-')).sort()) {
    const dir = path.join(root, name);
    const meta = readJson(path.join(dir, 'meta.json'));
    if (!meta) continue;
    const verify = readJson(path.join(dir, 'verify.json'));
    const leak = readJson(path.join(dir, 'leak.json'));
    runs.push({ dir, meta, verify, leak });
  }
}
if (!runs.length) { console.error('no completed runs found'); process.exit(1); }

const groups = new Map();
for (const r of runs) {
  const key = `${r.meta.platform}/${r.meta.scenario}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

console.log(`\n== setup-stress summary (${runs.length} runs) ==\n`);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('scenario', 28) + pad('n', 5) + pad('pass', 6) + pad('fail', 6) + pad('timeout', 9) + pad('leaks', 7) + 'avg min');
for (const [key, rs] of [...groups.entries()].sort()) {
  const pass = rs.filter(r => r.verify && r.verify.ok).length;
  const timeouts = rs.filter(r => r.meta.claudeTimedOut).length;
  const leaks = rs.filter(r => (r.meta.leakCount || 0) > 0).length;
  const avg = rs.reduce((a, r) => a + (r.meta.claudeDurationSec || 0), 0) / rs.length / 60;
  console.log(pad(key, 28) + pad(rs.length, 5) + pad(pass, 6) + pad(rs.length - pass, 6) + pad(timeouts, 9) + pad(leaks, 7) + avg.toFixed(1));
}

// failure buckets: first failing check per failed run
const buckets = new Map();
for (const r of runs) {
  if (r.verify && r.verify.ok) continue;
  const first = r.verify && r.verify.checks ? (r.verify.checks.find(c => !c.pass) || {}).name : 'no-verify-output';
  const key = r.meta.claudeTimedOut ? 'claude-timeout' : (first || 'unknown');
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(r);
}

if (buckets.size) {
  console.log('\n== failure buckets ==\n');
  for (const [key, rs] of [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${key} (${rs.length}):`);
    for (const r of rs.slice(0, 20)) {
      const detail = r.verify && r.verify.checks ? r.verify.checks.filter(c => !c.pass).map(c => c.name).join(',') : '-';
      console.log(`  ${r.dir}  [${r.meta.scenario}] failed: ${detail}`);
    }
    if (rs.length > 20) console.log(`  ... and ${rs.length - 20} more`);
  }
}

const leaky = runs.filter(r => (r.meta.leakCount || 0) > 0);
if (leaky.length) {
  console.log('\n== sandbox leaks (agent wrote outside sandbox) ==\n');
  for (const r of leaky) console.log(`  ${r.dir}`);
}

// cost/turn stats from the stream-json result line, when present
let cost = 0, turns = 0, costN = 0;
for (const r of runs) {
  const f = path.join(r.dir, 'stdout.ndjson');
  if (!fs.existsSync(f)) continue;
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    try {
      const j = JSON.parse(lines[i]);
      if (j.type === 'result') { cost += j.total_cost_usd || 0; turns += j.num_turns || 0; costN++; break; }
    } catch { /* not json */ }
  }
}
if (costN) console.log(`\nresult lines parsed: ${costN}, total reported cost: $${cost.toFixed(2)}, avg turns: ${(turns / costN).toFixed(1)}`);
console.log();
