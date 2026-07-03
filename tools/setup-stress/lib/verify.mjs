#!/usr/bin/env node
// Deterministic post-run verification for the AI_SETUP stress harness.
// Runs INSIDE the sandbox environment (fake HOME, scrubbed PATH), so
// os.homedir() and PATH resolution reflect the sandbox, not the real user.
//
// Usage: node verify.mjs <projectDir>
// Prints a JSON report to stdout. Exit code 0 = all checks pass, 1 = failures.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const project = process.argv[2];
if (!project || !fs.existsSync(project)) {
  console.log(JSON.stringify({ ok: false, fatal: `project dir not found: ${project}` }));
  process.exit(1);
}

const isWin = process.platform === 'win32';
const checks = [];

function check(name, fn) {
  try {
    const r = fn();
    checks.push({ name, pass: !!r.pass, detail: r.detail ?? null });
  } catch (e) {
    checks.push({ name, pass: false, detail: `exception: ${String(e && e.message || e)}` });
  }
}

function run(cmdline, timeoutMs = 180000) {
  // shell:true so npx.cmd / PATH resolution works identically on both platforms
  const r = spawnSync(cmdline, { cwd: project, encoding: 'utf8', timeout: timeoutMs, shell: true });
  return {
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    timedOut: r.error && r.error.code === 'ETIMEDOUT',
  };
}

function readJsonLoose(s) {
  // tolerate leading log lines before the JSON body
  const i = s.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

// 1. doctor --json must exit 0 with status ok
check('doctor', () => {
  const r = run('npx @shakystar/memorize doctor --json');
  if (r.timedOut) return { pass: false, detail: 'doctor timed out' };
  const j = readJsonLoose(r.stdout);
  const status = j && j.status;
  const issues = j && j.issues ? j.issues.map(x => x.id || x.title || x.message).slice(0, 10) : null;
  return {
    pass: r.status === 0 && status === 'ok',
    detail: { exit: r.status, status: status ?? null, issues, stderr: r.stderr.slice(0, 500) || null },
  };
});

// 2. memorize binary resolvable the way the guide requires:
//    devDependency in package.json, OR `memorize` on (sandbox) PATH
check('binResolvable', () => {
  const pkgPath = path.join(project, 'package.json');
  let viaDevDep = false;
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    viaDevDep = !!((pkg.devDependencies && pkg.devDependencies['@shakystar/memorize']) ||
                   (pkg.dependencies && pkg.dependencies['@shakystar/memorize']));
  }
  const r = run(isWin ? 'where memorize' : 'command -v memorize', 20000);
  const viaPath = r.status === 0;
  return { pass: viaDevDep || viaPath, detail: { viaDevDep, viaPath } };
});

// 3. Claude Code hooks wired into project-scoped settings
check('claudeHooks', () => {
  const p = path.join(project, '.claude', 'settings.local.json');
  if (!fs.existsSync(p)) return { pass: false, detail: 'settings.local.json absent' };
  const raw = fs.readFileSync(p, 'utf8');
  return { pass: /memorize/.test(raw), detail: /memorize/.test(raw) ? 'hooks present' : 'file exists but no memorize entries' };
});

// 4. .memorize/ listed in .gitignore
check('gitignore', () => {
  const p = path.join(project, '.gitignore');
  if (!fs.existsSync(p)) return { pass: false, detail: '.gitignore absent' };
  const has = fs.readFileSync(p, 'utf8').split(/\r?\n/).some(l => l.trim().replace(/\/$/, '') === '.memorize');
  return { pass: has, detail: has ? null : '.gitignore exists but no .memorize entry' };
});

// 5. project bound: project show returns JSON
check('projectShow', () => {
  const r = run('npx @shakystar/memorize project show', 60000);
  const j = readJsonLoose(r.stdout);
  const id = j && (j.projectId || j.id || (j.project && (j.project.id || j.project.projectId))) || null;
  return { pass: r.status === 0 && !!j, detail: { exit: r.status, id, stderr: r.stderr.slice(0, 300) || null } };
});

// 6. store created under (fake) home
check('storeInHome', () => {
  const p = path.join(os.homedir(), '.memorize');
  const exists = fs.existsSync(p);
  return { pass: exists, detail: { path: p, exists } };
});

const ok = checks.every(c => c.pass);
console.log(JSON.stringify({ ok, checks }, null, 2));
process.exit(ok ? 0 : 1);
