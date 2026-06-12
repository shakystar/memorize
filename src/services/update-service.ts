import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import which from 'which';

import type { Project } from '../domain/entities.js';
import { isEnoent, readJson, writeJson } from '../storage/fs-utils.js';
import { getMemorizeRoot } from '../storage/path-resolver.js';
import {
  installClaudeIntegration,
  installCodexHooks,
} from './install-service.js';
import { listProjects } from './project-service.js';
import { importContextFiles } from './setup-service.js';

export const PACKAGE_NAME = '@shakystar/memorize';

const WIN = process.platform === 'win32';

export function getCurrentVersion(): string {
  const pkg = createRequire(import.meta.url)('../../package.json') as {
    version: string;
  };
  return pkg.version;
}

/**
 * Minimal semver compare — numeric per segment, prerelease suffix ignored
 * (v1 scope: we only ever compare published registry versions).
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const seg = (v: string): number[] =>
    (v.split('-')[0] ?? '').split('.').map((n) => Number(n) || 0);
  const a = seg(latest);
  const b = seg(current);
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

export interface RefreshResult {
  codexRefreshed: boolean;
  /** rootPaths whose claude hooks were re-installed */
  claudeRefreshed: string[];
  reimported: Array<{ projectId: string; rootPath: string; count: number }>;
  failures: Array<{ target: string; message: string }>;
}

/**
 * External-process seams for the self-update flow. Injectable so unit
 * tests never touch npm or spawn real binaries (same pattern as
 * hook-service's DetachedSpawnImpl).
 */
export interface UpdateDeps {
  /** `npm <args>` capturing stdout — registry version lookup. */
  npmCapture(args: string[]): Promise<string>;
  /** `npm <args>` with stdio inherit — the global install. Resolves exit code. */
  npmInherit(args: string[]): Promise<number>;
  /** Resolve the global memorize binary; null when not on PATH. */
  whichMemorize(): string | null;
  /** Run the (freshly installed) memorize binary, stdio inherit. */
  runMemorize(args: string[]): Promise<number>;
  /** The machine-wide refresh. Seam so self-update tests stay pure. */
  refresh(): Promise<RefreshResult>;
}

export function defaultUpdateDeps(): UpdateDeps {
  return {
    npmCapture: (args) =>
      new Promise((resolve, reject) => {
        execFile(
          'npm',
          args,
          { timeout: 30_000, shell: WIN },
          (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          },
        );
      }),
    npmInherit: (args) =>
      new Promise((resolve, reject) => {
        const child = spawn('npm', args, { stdio: 'inherit', shell: WIN });
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? 1));
      }),
    whichMemorize: () => which.sync('memorize', { nothrow: true }),
    runMemorize: (args) =>
      new Promise((resolve, reject) => {
        // Resolve AFTER npm install — the shim path may have just changed.
        const bin = which.sync('memorize', { nothrow: true });
        if (!bin) {
          reject(new Error('memorize is no longer on PATH after the upgrade'));
          return;
        }
        const child = spawn(bin, args, { stdio: 'inherit', shell: WIN });
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? 1));
      }),
    refresh: () => runRefresh(),
  };
}

export function formatRefreshSummary(result: RefreshResult): string[] {
  const fileCount = result.reimported.reduce((n, r) => n + r.count, 0);
  const lines = [
    `Refresh complete (memorize v${getCurrentVersion()}).`,
    `  codex hooks: ${result.codexRefreshed ? 'refreshed' : 'not installed — skipped'}`,
    `  claude hooks: ${result.claudeRefreshed.length} project(s) refreshed`,
    `  context re-imported: ${fileCount} file(s) across ${result.reimported.length} project(s)`,
  ];
  for (const failure of result.failures) {
    lines.push(`  FAILED ${failure.target}: ${failure.message}`);
  }
  return lines;
}

/**
 * `memorize update` body. Version check → npm global upgrade → re-exec
 * the NEW binary with `--post-only` so the refresh runs new code. When
 * already up to date the refresh runs in-process instead (update doubles
 * as a repair command). Never deletes anything — see the design spec's
 * data-preservation invariants.
 */
export async function runSelfUpdate(
  deps: UpdateDeps = defaultUpdateDeps(),
  log: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  const current = getCurrentVersion();

  if (!deps.whichMemorize()) {
    log('No global memorize install found — nothing to self-upgrade.');
    log(`Install it first: npm install -g ${PACKAGE_NAME}`);
    return 1;
  }

  let latest: string;
  try {
    latest = (await deps.npmCapture(['view', PACKAGE_NAME, 'version'])).trim();
    if (!latest) throw new Error('empty version from registry');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Could not reach the npm registry: ${message}`);
    return 1;
  }

  if (!isNewerVersion(latest, current)) {
    log(
      isNewerVersion(current, latest)
        ? `Local v${current} is ahead of the registry (v${latest}) — skipping install. Refreshing integrations.`
        : `Already up to date (v${current}). Refreshing integrations.`,
    );
    const result = await deps.refresh();
    for (const line of formatRefreshSummary(result)) log(line);
    return result.failures.length > 0 ? 1 : 0;
  }

  log(`Upgrading ${PACKAGE_NAME} v${current} -> v${latest} ...`);
  const installCode = await deps.npmInherit([
    'install',
    '-g',
    `${PACKAGE_NAME}@latest`,
  ]);
  if (installCode !== 0) {
    log('npm install failed; refresh skipped (nothing was changed).');
    return installCode;
  }
  log(`Upgraded to v${latest}. Refreshing integrations with the new binary ...`);
  // The refresh must run NEW code — re-exec the freshly installed binary.
  return deps.runMemorize(['update', '--post-only']);
}

/** Matches any memorize hook command form for the given agent. */
const MEMORIZE_CODEX_HOOK_RE = /(@shakystar\/)?memorize\s+hook\s+codex\s/;
const MEMORIZE_CLAUDE_HOOK_RE = /(@shakystar\/)?memorize\s+hook\s+claude\s/;

export interface RefreshDeps {
  listProjects(): Promise<Project[]>;
  installCodexHooks(): Promise<string>;
  installClaudeIntegration(cwd: string): Promise<string>;
  reimportProjectContext(project: Project): Promise<number>;
  /** undefined on missing file. */
  readTextFile(filePath: string): Promise<string | undefined>;
  codexHooksFile(): string;
}

export function defaultRefreshDeps(): RefreshDeps {
  return {
    listProjects,
    installCodexHooks,
    installClaudeIntegration,
    reimportProjectContext: importContextFiles,
    readTextFile: async (filePath) => {
      try {
        return await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if (isEnoent(error)) return undefined;
        throw error;
      }
    },
    codexHooksFile: () => path.join(os.homedir(), '.codex', 'hooks.json'),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Machine-wide integration refresh (`update --post-only`). Idempotent;
 * refreshes EXISTING installs only (never installs fresh), re-imports
 * changed context files, and isolates per-project failures so one broken
 * project cannot block the rest. Data-preservation invariants: every
 * sub-step is additive — install-service strip-and-rebuild only touches
 * memorize's own hook entries, and the idempotent import only appends
 * rule.upserted events for discovered, changed files.
 */
export async function runRefresh(
  deps: RefreshDeps = defaultRefreshDeps(),
): Promise<RefreshResult> {
  const result: RefreshResult = {
    codexRefreshed: false,
    claudeRefreshed: [],
    reimported: [],
    failures: [],
  };

  try {
    const codexRaw = await deps.readTextFile(deps.codexHooksFile());
    if (codexRaw && MEMORIZE_CODEX_HOOK_RE.test(codexRaw)) {
      await deps.installCodexHooks();
      result.codexRefreshed = true;
    }
  } catch (error) {
    result.failures.push({ target: 'codex hooks', message: errorMessage(error) });
  }

  let projects: Project[] = [];
  try {
    projects = await deps.listProjects();
  } catch (error) {
    result.failures.push({
      target: 'project list',
      message: errorMessage(error),
    });
  }

  for (const project of projects) {
    // Use posix join so the path preserves the rootPath's separator style.
    // Node.js fs accepts forward-slash paths on Windows, and tests pass
    // POSIX-style roots that path.win32.join would mangle (drop the '/').
    const settingsFile = path.posix.join(
      project.rootPath,
      '.claude',
      'settings.local.json',
    );
    try {
      const raw = await deps.readTextFile(settingsFile);
      if (raw && MEMORIZE_CLAUDE_HOOK_RE.test(raw)) {
        await deps.installClaudeIntegration(project.rootPath);
        result.claudeRefreshed.push(project.rootPath);
      }
    } catch (error) {
      result.failures.push({
        target: `claude hooks: ${project.rootPath}`,
        message: errorMessage(error),
      });
    }

    try {
      // A vanished rootPath discovers zero files and emits nothing — the
      // existing imported rules are untouched (data-preservation #2).
      const count = await deps.reimportProjectContext(project);
      if (count > 0) {
        result.reimported.push({
          projectId: project.id,
          rootPath: project.rootPath,
          count,
        });
      }
    } catch (error) {
      result.failures.push({
        target: `context re-import: ${project.rootPath}`,
        message: errorMessage(error),
      });
    }
  }

  return result;
}

// --- session-start update notice (notify-only, never blocking) -------------

export interface UpdateCheckCache {
  checkedAt: string;
  latest: string;
}

export function getUpdateCheckFile(): string {
  return path.join(getMemorizeRoot(), 'update-check.json');
}

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * `update --check` body: one registry lookup → cache write. Spawned
 * DETACHED by SessionStart, so it must never print, never prompt, and
 * never fail loudly — on any error the previous cache is left intact and
 * the next boundary retries.
 */
export async function recordUpdateCheck(
  deps: Pick<UpdateDeps, 'npmCapture'> = defaultUpdateDeps(),
): Promise<void> {
  try {
    const latest = (
      await deps.npmCapture(['view', PACKAGE_NAME, 'version'])
    ).trim();
    // Strict semver shape gate: the cached string is later interpolated
    // into hook-injected context, so reject anything but a clean version
    // (a hostile registry response must not become an injection vector).
    if (!latest || !/^\d+\.\d+\.\d+(?:[-+][\w.]+)*$/.test(latest)) return;
    await writeJson(getUpdateCheckFile(), {
      checkedAt: new Date().toISOString(),
      latest,
    } satisfies UpdateCheckCache);
  } catch {
    // offline / registry down — keep the old cache
  }
}

export interface UpdateNotice {
  /** present when the cached latest is newer than this binary */
  notice?: string;
  /** true when the cache is missing or older than the TTL */
  shouldCheck: boolean;
}

/** Cache-only read — NEVER hits the network (hook + doctor safe). */
export async function getUpdateNotice(
  now: Date = new Date(),
): Promise<UpdateNotice> {
  const cache = await readJson<UpdateCheckCache>(getUpdateCheckFile());
  const shouldCheck =
    !cache ||
    now.getTime() - new Date(cache.checkedAt).getTime() > UPDATE_CHECK_TTL_MS;
  const current = getCurrentVersion();
  const notice =
    cache && isNewerVersion(cache.latest, current)
      ? `memorize v${cache.latest} available (current v${current}) — run \`memorize update\``
      : undefined;
  return { ...(notice ? { notice } : {}), shouldCheck };
}
