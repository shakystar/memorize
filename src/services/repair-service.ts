import fs from 'node:fs/promises';
import path from 'node:path';

import { readEventsWithIntegrity } from '../storage/event-store.js';
import { isEnoent, readJson } from '../storage/fs-utils.js';
import {
  getMemoryIndexFile,
  getProjectRoot,
} from '../storage/path-resolver.js';
import { rebuildProjectProjection } from './projection-store.js';
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
  const memoryIndex = await readJson(getMemoryIndexFile(projectId));
  return memoryIndex ? 'Memory index rebuild complete' : 'Memory index missing';
}

export async function validateEvents(cwd: string): Promise<string> {
  const projectId = await requireBoundProjectId(cwd);
  const { events, corruptLines } = await readEventsWithIntegrity(projectId);
  if (events.length === 0 && corruptLines.length === 0) {
    throw new Error('No events found for project.');
  }
  if (corruptLines.length > 0) {
    return `Event validation found ${corruptLines.length} corrupt line(s)`;
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

const REQUIRED_DIRS = ['events', 'tasks', 'workstreams', 'rules', 'sync'] as const;

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
  const events = ['SessionStart', 'PreCompact', 'PostCompact', 'Stop'];
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
    message: `All 4 memorize hooks present in .claude/settings.local.json`,
  };
}

async function checkCodexInstall(
  cwd: string,
): Promise<DoctorCheck | undefined> {
  const overridePath = path.join(cwd, 'AGENTS.override.md');
  let content: string;
  try {
    content = await fs.readFile(overridePath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  const hasMarker =
    content.includes('<!-- memorize:bootstrap v=1 start -->') &&
    content.includes('<!-- memorize:bootstrap v=1 end -->');
  if (!hasMarker) return undefined;
  return {
    id: 'install.codex',
    label: 'Codex bootstrap block',
    status: 'ok',
    message: 'memorize managed block present in AGENTS.override.md',
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
          fix: 'memorize projection rebuild',
        });
      }
    }
  }

  if (projectId) {
    const { corruptLines } = await readEventsWithIntegrity(projectId);
    if (corruptLines.length === 0) {
      checks.push({
        id: 'events.integrity',
        label: 'Event log integrity',
        status: 'ok',
        message: 'All event lines parse successfully',
      });
    } else {
      checks.push({
        id: 'events.integrity',
        label: 'Event log integrity',
        status: 'warn',
        message: `${corruptLines.length} corrupt line(s) found: ${corruptLines.map((c) => `${c.file}:${c.lineNumber}`).join(', ')}`,
        fix: 'memorize events validate',
      });
    }
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
