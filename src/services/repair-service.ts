import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { spawnSync } from 'node:child_process';

import { getDb } from '../storage/db.js';
import { readEventsWithIntegrity } from '../storage/event-store.js';
import { isEnoent } from '../storage/fs-utils.js';
import { getProjectRoot } from '../storage/path-resolver.js';
import {
  CLAUDE_HOOK_EVENTS,
  isMemorizeHookCommandForAgent,
} from './install-service.js';
import {
  type ConsolidateAttempt,
  getConsolidationStatus,
} from './consolidate-service.js';
import { hasUnmigratedNdjson } from './migrate-service.js';
import {
  getMemoryIndex,
  listSessions,
  rebuildProjectProjection,
} from './projection-store.js';
import { getBoundProjectId, readProject, requireBoundProjectId } from './project-service.js';
import { getCurrentVersion, getUpdateNotice } from './update-service.js';

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
  // #130 — doctor must check the SAME event set the installer wires, or a
  // missing hook (e.g. PostToolUse) reads as a false green. Sourced from the
  // single CLAUDE_HOOK_EVENTS constant in install-service so they can't drift.
  const events = [...CLAUDE_HOOK_EVENTS];
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
    // Shared matcher with the install strip (#122) — also recognizes the
    // node-abs form `node "<.../cli/index.js>" hook claude ...`, so doctor
    // never reports a correctly-installed node-abs hook as missing.
    (entry.hooks ?? []).some((inner) =>
      isMemorizeHookCommandForAgent(inner.command ?? '', 'claude'),
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

  // #123 — presence is not runnability. With #122's node-abs form, a hook
  // entry can be PRESENT yet point at a cli.js that does not exist (stale
  // worktree, moved install), so it fails `command not found` at runtime
  // while doctor reports a false green. Probe the actual command harmlessly.
  const probeFailure = probeClaudeHookExecutability(hooks, events);
  if (probeFailure) {
    return {
      id: 'install.claude',
      label: 'Claude hook integration',
      status: 'error',
      message: probeFailure,
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

/**
 * #123 executability probe. Take a present memorize hook command and confirm
 * the binary it resolves to is actually runnable, mirroring the shell
 * semantics Claude Code uses (Git Bash on Windows). Non-destructive: we run
 * `--version` against the SAME binary, never the real `hook` subcommand
 * (which has side effects).
 *
 * Only the node-abs form (#122) is probed — that's the form a real Windows
 * install writes and the one whose runtime resolvability presence-checking
 * cannot see. The `npx`/legacy-bare forms can't be probed cheaply offline
 * (npx hits the network; bare `memorize` resolves differently per shell), so
 * for them we keep presence-only — they were never the #123 false-green.
 * Returns an error message on failure, or undefined when the probe passes
 * (or is not applicable).
 */
function probeClaudeHookExecutability(
  hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>,
  events: string[],
): string | undefined {
  // Find the first node-abs memorize command across the checked events.
  let nodeAbsCommand: string | undefined;
  for (const event of events) {
    for (const group of hooks[event] ?? []) {
      for (const inner of group.hooks ?? []) {
        const cmd = inner.command ?? '';
        if (
          isMemorizeHookCommandForAgent(cmd, 'claude') &&
          /^node\s+"[^"]*\/cli\/index\.js"/.test(cmd)
        ) {
          nodeAbsCommand = cmd;
          break;
        }
      }
      if (nodeAbsCommand) break;
    }
    if (nodeAbsCommand) break;
  }
  if (!nodeAbsCommand) return undefined; // npx/bare form — presence-only.

  // Derive a harmless probe: same `node "<abs>"` prefix, `--version` instead
  // of the `hook <agent> <event>` suffix.
  const prefixMatch = nodeAbsCommand.match(/^node\s+"[^"]*\/cli\/index\.js"/);
  if (!prefixMatch) return undefined;
  const probeCommand = `${prefixMatch[0]} --version`;

  // Run via a shell so PATH/`node` resolution matches the hook's runtime
  // (Claude Code fires hooks through Git Bash on Windows; spawning with
  // shell:true uses the platform default shell — close enough to catch an
  // unresolvable command, and `node` is resolvable in either).
  const result = spawnSync(probeCommand, {
    shell: true,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status === 0) return undefined;
  return `Claude hook command is not runnable: \`${probeCommand}\` exited ${
    result.status ?? 'with no exit code'
  }${result.error ? ` (${result.error.message})` : ''}`;
}

async function checkCodexInstall(
  _cwd: string,
  projectId?: string,
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

  // The CLS contract registers SessionStart (lifecycle + consolidation
  // catch-up), PostToolUse (capture), and PostCompact (boundary). Codex
  // has no SessionEnd hook (verified May 2026).
  const events = ['SessionStart', 'PostToolUse', 'PostCompact'];
  const hooks = parsed.hooks ?? {};
  const missing = events.filter((event) => {
    const list = hooks[event] ?? [];
    return !list.some((group) =>
      // Shared matcher (#122) — recognizes npx/bare AND the node-abs form.
      (group.hooks ?? []).some((h) =>
        isMemorizeHookCommandForAgent(h.command ?? '', 'codex'),
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
      message: `Missing memorize hooks in ~/.codex/hooks.json (${events.join(', ')})`,
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
  // Registration is the most doctor can verify DIRECTLY: codex keeps its
  // hook trust state internal and SILENTLY skips externally-written hooks
  // until the user approves them once in an interactive session (verified
  // live against codex v0.137.0, 2026-06-08; upstream fix tracked in
  // openai/codex#21615). #37 — INFER the trust gap from the bound project:
  // hooks registered + other agents recorded sessions + codex never did →
  // the hooks have likely never fired. The other-agents guard keeps a
  // fresh install (no sessions at all) from being flagged.
  if (projectId) {
    try {
      const sessions = listSessions(projectId);
      const codexSeen = sessions.some((session) => session.actor === 'codex');
      const othersSeen = sessions.some((session) => session.actor !== 'codex');
      if (!codexSeen && othersSeen) {
        return {
          id: 'install.codex',
          label: 'Codex integration',
          status: 'warn',
          message:
            'memorize hooks are registered in ~/.codex/hooks.json, but no codex session has ever been ' +
            'recorded in this project (other agents have) — codex silently skips externally-written ' +
            'hooks until they are approved once in an interactive session.',
          fix: 'Run codex interactively once and approve the memorize hooks when prompted',
        };
      }
    } catch {
      // Heuristic only — a projection read failure must not fail doctor;
      // fall through to the registration-level ok below.
    }
  }
  return {
    id: 'install.codex',
    label: 'Codex integration',
    status: 'ok',
    message:
      'memorize hooks registered in ~/.codex/hooks.json (SessionStart, PostToolUse, PostCompact). ' +
      'Note: codex runs externally-written hooks only after you approve them once in an interactive codex session.',
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
 * True-replica invariant (#30): one store holds exactly ONE project identity.
 * More than one distinct `project.created` id means a cross-machine bind
 * clobbered identity (the pre-clone-on-bind bug) — `reduceProjectState` now
 * throws on this, and `getProjectProjection` would otherwise have returned an
 * empty/wrong row. Uses a raw SQL COUNT(DISTINCT …) rather than
 * `reduceProjectState` so doctor still runs on an already-diverged store (the
 * reducer would throw before we could report).
 */
function checkProjectIdentity(projectId: string): DoctorCheck {
  const distinct = (
    getDb(projectId)
      .prepare(
        "SELECT COUNT(DISTINCT json_extract(payload, '$.id')) AS n " +
          "FROM events WHERE type = 'project.created'",
      )
      .get() as { n: number }
  ).n;
  if (distinct > 1) {
    return {
      id: 'project.identity',
      label: 'Single project identity in event log',
      status: 'error',
      message:
        `Event log holds ${distinct} distinct project.created ids (#30 ` +
        'cross-machine clobber). Re-clone into a fresh directory ' +
        '(`memorize project clone <id> --remote-path <path>`); in-place repair ' +
        'of a diverged log is unsupported.',
      fix: 'memorize project clone <remoteProjectId> --remote-path <path> (fresh dir)',
    };
  }
  return {
    id: 'project.identity',
    label: 'Single project identity in event log',
    status: 'ok',
    message: 'Event log holds a single project identity',
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

/**
 * #51 — consolidation health. A store with observations but no memories must
 * answer WHY (the emis case: 190 observations, 0 memories, no trace).
 * Warn policy:
 *   - observations are pending AND the last recorded attempt failed, or
 *   - many observations are pending and NO attempt was ever recorded
 *     (boundaries are likely not firing at all — the threshold keeps a
 *     fresh mid-session store from warning before its first boundary).
 * Everything else (idle, healthy, or merely a few pending) is ok; the
 * message always carries the pending count + last-attempt summary so
 * `doctor --json` exposes the full picture either way.
 */
const PENDING_WITHOUT_ATTEMPT_WARN_THRESHOLD = 25;

function describeAttempt(attempt: ConsolidateAttempt): string {
  return (
    `last attempt ${attempt.at} at ${attempt.boundary} via ${attempt.backend} ` +
    `→ ${attempt.outcome}${attempt.error ? ` (${attempt.error})` : ''}`
  );
}

function checkConsolidationHealth(projectId: string): DoctorCheck {
  const status = getConsolidationStatus(projectId);
  const pendingPart =
    status.pendingObservations > 0
      ? `${status.pendingObservations} observation(s) pending since watermark` +
        (status.oldestPendingAt ? ` (oldest ${status.oldestPendingAt})` : '')
      : 'no observations pending';
  const attemptPart = status.lastAttempt
    ? describeAttempt(status.lastAttempt)
    : 'no consolidation attempt recorded';
  const message = `${pendingPart}; ${attemptPart}`;

  const lastAttemptFailed =
    status.lastAttempt !== undefined &&
    status.lastAttempt.outcome !== 'ok' &&
    status.lastAttempt.outcome !== 'noop';
  const neverAttemptedWithBacklog =
    status.lastAttempt === undefined &&
    status.pendingObservations > PENDING_WITHOUT_ATTEMPT_WARN_THRESHOLD;

  if ((status.pendingObservations > 0 && lastAttemptFailed) || neverAttemptedWithBacklog) {
    return {
      id: 'consolidation.health',
      label: 'Memory consolidation health',
      status: 'warn',
      message,
      fix: 'memorize consolidate',
    };
  }
  return {
    id: 'consolidation.health',
    label: 'Memory consolidation health',
    status: 'ok',
    message,
  };
}

async function buildUpdateVersionCheck(): Promise<DoctorCheck> {
  const current = getCurrentVersion();
  let notice: string | undefined;
  try {
    ({ notice } = await getUpdateNotice());
  } catch {
    // corrupt cache file — version info is best-effort, never fails doctor
  }
  return {
    id: 'update.version',
    label: 'CLI version',
    status: 'ok',
    message: notice ? `v${current} — ${notice}` : `v${current}`,
  };
}

export async function doctor(cwd: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  // Cache-only version info (no network in doctor) — status stays 'ok'
  // because "a newer version exists" must not flip doctor to exit 1.
  checks.push(await buildUpdateVersionCheck());
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
    if (!checks.some((check) => check.id === 'project.bound')) {
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

    checks.push(checkProjectIdentity(projectId));
    checks.push(checkProjectionBuilt(projectId));
    checks.push(checkConsolidationHealth(projectId));

    const ndjsonCheck = await checkNdjsonMigrated(projectId);
    if (ndjsonCheck) checks.push(ndjsonCheck);
  }

  const claudeCheck = await checkClaudeInstall(cwd);
  if (claudeCheck) checks.push(claudeCheck);

  const codexCheck = await checkCodexInstall(cwd, projectId);
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
