import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getDb } from '../storage/db.js';
import { readEventsWithIntegrity } from '../storage/event-store.js';
import { isEnoent } from '../storage/fs-utils.js';
import { getProjectRoot } from '../storage/path-resolver.js';
import { hasUnmigratedNdjson } from './migrate-service.js';
import { getMemoryIndex, rebuildProjectProjection } from './projection-store.js';
import { getBoundProjectId, readProject, requireBoundProjectId } from './project-service.js';

export async function inspectProject(cwd: string): Promise<string> {
  const projectId = await requireBoundProjectId(cwd);
  const project = await readProject(projectId);
  return JSON.stringify(project, null, 2);
}

export async function rebuildProjection(cwd: string): Promise<string> {
  const projectId = await requireBoundProjectId(cwd);
  await rebuildProjectProjection(projectId);
  return 'Projection rebuild complete';
}

export async function rebuildMemoryIndex(cwd: string): Promise<string> {
  const projectId = await requireBoundProjectId(cwd);
  await rebuildProjectProjection(projectId);
  const memoryIndex = getMemoryIndex(projectId);
  return memoryIndex ? 'Memory index rebuild complete' : 'Memory index missing';
}

export async function validateEvents(cwd: string): Promise<string> {
  const projectId = await requireBoundProjectId(cwd);
  const { events } = await readEventsWithIntegrity(projectId);
  if (events.length === 0) {
    throw new Error('No events found for project.');
  }
  return 'Event validation passed';
}

export const DOCTOR_REPORT_VERSION = '1';

export type DoctorStatus = 'ok' | 'warn' | 'error';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  fix?: string;
}

export interface DoctorIssue {
  id: string;
  severity: Exclude<DoctorStatus, 'ok'>;
  fix?: string;
}

export interface DoctorReport {
  status: DoctorStatus;
  checks: DoctorCheck[];
  issues: DoctorIssue[];
  version: string;
}

// Post-SQLite: the event log AND the entity projections (tasks, workstreams,
// rules, …) now live in memorize.db, so their old JSON dirs are no longer a
// health signal. `sync` still holds the remote sync-state JSON on disk.
const REQUIRED_DIRS = ['sync'] as const;

function aggregateStatus(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === 'error')) return 'error';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'ok';
}

function gitignoreHasMemorize(gitignore: string): boolean {
  return gitignore.split('\n').some((raw) => {
    const commentStripped = raw.split('#', 1)[0] ?? '';
    const line = commentStripped.trim();
    if (!line || line.startsWith('!')) return false;
    return /^\/?\.memorize\/?$/.test(line);
  });
}

async function checkClaudeInstall(
  cwd: string,
): Promise<DoctorCheck | undefined> {
  const settingsPath = path.join(cwd, '.claude', 'settings.local.json');
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  let settings: {
    hooks?: Record<
      string,
      Array<{
        hooks?: Array<{ command?: string }>;
        command?: string;
      }>
    >;
  };
  try {
    settings = JSON.parse(raw);
  } catch {
    return {
      id: 'install.claude',
      label: 'Claude hook integration',
      status: 'warn',
      message: `.claude/settings.local.json is not valid JSON`,
      fix: 'memorize install claude',
    };
  }
  const events = ['SessionStart', 'PreCompact', 'PostCompact', 'SessionEnd'];
  const hooks = settings.hooks ?? {};

  const hasLegacyShape = events.some((event) => {
    const list = hooks[event] ?? [];
    return list.some(
      (entry) =>
        entry &&
        typeof entry.command === 'string' &&
        !Array.isArray(entry.hooks),
    );
  });
  if (hasLegacyShape) {
    return {
      id: 'install.claude',
      label: 'Claude hook integration',
      status: 'error',
      message:
        'Legacy memorize hook shape detected. Claude Code rejects entries without a `matcher` + `hooks` array.',
      fix: 'memorize install claude',
    };
  }

  const commandPresent = (entry: {
    hooks?: Array<{ command?: string }>;
  }): boolean =>
    (entry.hooks ?? []).some((inner) =>
      /memorize\s+hook\s+claude/.test(inner.command ?? ''),
    );

  const missing = events.filter(
    (event) => !(hooks[event] ?? []).some(commandPresent),
  );
  if (missing.length === events.length) {
    return undefined;
  }
  if (missing.length > 0) {
    return {
      id: 'install.claude',
      label: 'Claude hook integration',
      status: 'warn',
      message: `Missing memorize hooks for ${missing.join(', ')}`,
      fix: 'memorize install claude',
    };
  }
  return {
    id: 'install.claude',
    label: 'Claude hook integration',
    status: 'ok',
    message: `All ${events.length} memorize hooks present in .claude/settings.local.json`,
  };
}

async function checkCodexInstall(
  _cwd: string,
): Promise<DoctorCheck | undefined> {
  const hooksPath = path.join(os.homedir(), '.codex', 'hooks.json');
  let raw: string;
  try {
    raw = await fs.readFile(hooksPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  let parsed: {
    hooks?: Record<
      string,
      Array<{ hooks?: Array<{ command?: string }> }>
    >;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      id: 'install.codex',
      label: 'Codex integration',
      status: 'warn',
      message: '~/.codex/hooks.json is not valid JSON',
      fix: 'memorize install codex',
    };
  }

  // Codex has no SessionEnd hook (verified May 2026), so SessionStart
  // is the only memorize entry we expect to see post-β-redesign.
  const events = ['SessionStart'];
  const hooks = parsed.hooks ?? {};
  const missing = events.filter((event) => {
    const list = hooks[event] ?? [];
    return !list.some((group) =>
      (group.hooks ?? []).some((h) =>
        /memorize\s+hook\s+codex/.test(h.command ?? ''),
      ),
    );
  });

  if (missing.length === events.length) {
    // hooks.json exists for some other reason (OMX etc.) but memorize
    // hooks are absent — surface a warn so the user notices.
    return {
      id: 'install.codex',
      label: 'Codex integration',
      status: 'warn',
      message:
        'Missing memorize hooks in ~/.codex/hooks.json (SessionStart, Stop)',
      fix: 'memorize install codex',
    };
  }
  if (missing.length > 0) {
    return {
      id: 'install.codex',
      label: 'Codex integration',
      status: 'warn',
      message: `Missing memorize hooks for ${missing.join(', ')}`,
      fix: 'memorize install codex',
    };
  }
  return {
    id: 'install.codex',
    label: 'Codex integration',
    status: 'ok',
    message: 'memorize SessionStart + Stop hooks registered in ~/.codex/hooks.json',
  };
}

async function checkGitRedactionRisk(
  cwd: string,
): Promise<DoctorCheck | undefined> {
  try {
    await fs.access(path.join(cwd, '.git'));
  } catch {
    return undefined;
  }

  let gitignore = '';
  try {
    gitignore = await fs.readFile(path.join(cwd, '.gitignore'), 'utf8');
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  if (gitignoreHasMemorize(gitignore)) {
    return {
      id: 'git.ignore.memorize',
      label: 'Git ignores .memorize/',
      status: 'ok',
      message: '.memorize/ is listed in .gitignore',
    };
  }
  return {
    id: 'git.ignore.memorize',
    label: 'Git ignores .memorize/',
    status: 'warn',
    message:
      '.memorize/ is not gitignored. Event logs may leak to commits and expose stored prompts or secrets if shared.',
    fix: "add '.memorize/' to .gitignore",
  };
}

function checkDbIntegrity(projectId: string): DoctorCheck {
  let rows: Array<{ integrity_check: string }>;
  try {
    rows = getDb(projectId)
      .prepare('PRAGMA integrity_check')
      .all() as Array<{ integrity_check: string }>;
  } catch (error) {
    return {
      id: 'db.integrity',
      label: 'SQLite database integrity',
      status: 'error',
      message: error instanceof Error ? error.message : 'integrity_check failed',
      fix: 'memorize export --out events.ndjson  # rescue events, then rebuild',
    };
  }
  const ok = rows.length === 1 && rows[0]?.integrity_check === 'ok';
  if (ok) {
    return {
      id: 'db.integrity',
      label: 'SQLite database integrity',
      status: 'ok',
      message: 'PRAGMA integrity_check passed',
    };
  }
  return {
    id: 'db.integrity',
    label: 'SQLite database integrity',
    status: 'error',
    message: `PRAGMA integrity_check reported: ${rows
      .map((r) => r.integrity_check)
      .join('; ')}`,
    fix: 'memorize export --out events.ndjson  # rescue events, then rebuild',
  };
}

/**
 * The projection tables are derived state — they must hold a `project` row
 * whenever a `project.created` event exists in the log. A missing/empty
 * projection (e.g. after a manual db edit or an interrupted rebuild) is
 * recoverable by replaying events into the tables.
 */
function checkProjectionBuilt(projectId: string): DoctorCheck {
  const db = getDb(projectId);
  const eventCount = (
    db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
  ).n;
  const projectRow = db
    .prepare('SELECT 1 FROM projects WHERE id = ?')
    .get(projectId);
  if (eventCount > 0 && !projectRow) {
    return {
      id: 'projection.built',
      label: 'Projection tables built from events',
      status: 'warn',
      message:
        'Event log is non-empty but the projection tables have no project row.',
      fix: 'memorize projection rebuild',
    };
  }
  return {
    id: 'projection.built',
    label: 'Projection tables built from events',
    status: 'ok',
    message: 'Projection tables are consistent with the event log',
  };
}

/**
 * `seq` is an autoincrement primary key, so a healthy append-only log has
 * `MAX(seq) === COUNT(*)` (rows 1..N with no holes). A mismatch means rows
 * were deleted from the middle of the log — the append-only contract is
 * broken and replay would skip events. An empty log (MAX(seq) NULL,
 * COUNT 0) is healthy. Replaces the old NDJSON corrupt-line scan, which
 * over SQLite could never fail (whole rows, no partial lines).
 */
function checkEventSeqGaps(projectId: string): DoctorCheck {
  const row = getDb(projectId)
    .prepare('SELECT MAX(seq) AS max, COUNT(*) AS count FROM events')
    .get() as { max: number | null; count: number };
  const max = row.max ?? 0;
  if (max === row.count) {
    return {
      id: 'events.integrity',
      label: 'Event log integrity',
      status: 'ok',
      message: 'Event sequence is contiguous (no gaps)',
    };
  }
  return {
    id: 'events.integrity',
    label: 'Event log integrity',
    status: 'warn',
    message: `Event sequence has a gap: MAX(seq)=${max} but COUNT=${row.count} (rows deleted/missing)`,
    fix: 'memorize events validate',
  };
}

/**
 * Opening the DB only runs DDL migrations — it never imports a legacy NDJSON
 * event log into the SQLite `events` table (only the explicit `memorize
 * migrate` command does that). A project upgraded from the NDJSON era thus
 * reads as an EMPTY store until the user migrates, which looks like lost
 * memory. Surface it loudly here so the fix is obvious.
 */
async function checkNdjsonMigrated(
  projectId: string,
): Promise<DoctorCheck | undefined> {
  if (!(await hasUnmigratedNdjson(projectId))) return undefined;
  return {
    id: 'migrate.ndjson',
    label: 'Legacy NDJSON event log migrated to SQLite',
    status: 'warn',
    message:
      'Legacy NDJSON event log detected but not yet migrated to SQLite. Run `memorize migrate` to import it.',
    fix: 'memorize migrate',
  };
}

export async function doctor(cwd: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let projectId: string | undefined;
  try {
    projectId = (await getBoundProjectId(cwd)) ?? undefined;
  } catch (error) {
    checks.push({
      id: 'project.bound',
      label: 'Project bound to current directory',
      status: 'error',
      message:
        error instanceof Error ? error.message : 'Failed to read project binding.',
      fix: 'memorize project setup',
    });
  }

  if (!projectId) {
    if (checks.length === 0) {
      checks.push({
        id: 'project.bound',
        label: 'Project bound to current directory',
        status: 'error',
        message: 'No project bound to current directory.',
        fix: 'memorize project setup',
      });
    }
  } else {
    checks.push({
      id: 'project.bound',
      label: 'Project bound to current directory',
      status: 'ok',
      message: `Bound to project ${projectId}`,
    });

    const projectRoot = getProjectRoot(projectId);
    for (const dirName of REQUIRED_DIRS) {
      try {
        await fs.access(path.join(projectRoot, dirName));
        checks.push({
          id: `project.storage.${dirName}`,
          label: `Storage directory: ${dirName}`,
          status: 'ok',
          message: 'present',
        });
      } catch {
        checks.push({
          id: `project.storage.${dirName}`,
          label: `Storage directory: ${dirName}`,
          status: 'error',
          message: `Missing .memorize/${projectId}/${dirName}`,
          fix: 'memorize project setup',
        });
      }
    }
  }

  if (projectId) {
    checks.push(checkEventSeqGaps(projectId));

    const dbIntegrity = checkDbIntegrity(projectId);
    checks.push(dbIntegrity);

    checks.push(checkProjectionBuilt(projectId));

    const ndjsonCheck = await checkNdjsonMigrated(projectId);
    if (ndjsonCheck) checks.push(ndjsonCheck);
  }

  const claudeCheck = await checkClaudeInstall(cwd);
  if (claudeCheck) checks.push(claudeCheck);

  const codexCheck = await checkCodexInstall(cwd);
  if (codexCheck) checks.push(codexCheck);

  const gitCheck = await checkGitRedactionRisk(cwd);
  if (gitCheck) checks.push(gitCheck);

  const issues: DoctorIssue[] = checks
    .filter((check): check is DoctorCheck & { status: Exclude<DoctorStatus, 'ok'> } =>
      check.status !== 'ok',
    )
    .map((check) => ({
      id: check.id,
      severity: check.status,
      ...(check.fix === undefined ? {} : { fix: check.fix }),
    }));

  return {
    status: aggregateStatus(checks),
    checks,
    issues,
    version: DOCTOR_REPORT_VERSION,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  if (report.status === 'ok') {
    return 'Doctor check passed';
  }
  const lines = [`Doctor check ${report.status}`];
  for (const check of report.checks) {
    if (check.status === 'ok') continue;
    lines.push(`  [${check.status.toUpperCase()}] ${check.label}: ${check.message}`);
    if (check.fix !== undefined) {
      lines.push(`    fix: ${check.fix}`);
    }
  }
  return lines.join('\n');
}
