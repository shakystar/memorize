import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import which from 'which';

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
    log(`Already up to date (v${current}; latest v${latest}). Refreshing integrations.`);
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

export async function runRefresh(): Promise<RefreshResult> {
  throw new Error('runRefresh: implemented in Task 5');
}
