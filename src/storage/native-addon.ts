import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { getMemorizeRoot } from './path-resolver.js';

const require = createRequire(import.meta.url);

/**
 * Windows locks a loaded `.node` on disk, so a running memorize process
 * (watcher / MCP / consolidate) pins the global install's better_sqlite3.node
 * and blocks `npm i -g` / `memorize update` with EBUSY. Loading the addon from
 * a version-stamped shadow copy under ~/.memorize/runtime leaves the installed
 * file unlocked, so the update can overwrite it. win32-only; every other
 * platform (incl. WSL, which reports 'linux') allows unlink-replace and needs
 * nothing. See the mid-session self-update design spec.
 */

export const NATIVE_SHADOW_DISABLED_ENV_VAR = 'MEMORIZE_NATIVE_SHADOW_DISABLED';

export interface NativeAddonDeps {
  /** Whether shadow-loading is active (win32 AND not suite-disabled). */
  enabled: boolean;
  /** Absolute path to the installed addon, or null when not found. */
  sourcePath: () => string | null;
  /** Version string that stamps the shadow dir. */
  version: () => string;
  /** memorize data root (parent of runtime/). */
  root: () => string;
}

function packageVersion(): string {
  const pkg = require('../../package.json') as { version: string };
  return pkg.version;
}

/** Locate the installed better-sqlite3 native addon (build/Release form). */
function installedAddonPath(): string | null {
  try {
    const pkgJson = require.resolve('better-sqlite3/package.json');
    const candidate = path.join(
      path.dirname(pkgJson),
      'build',
      'Release',
      'better_sqlite3.node',
    );
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function defaultNativeAddonDeps(): NativeAddonDeps {
  return {
    enabled:
      process.platform === 'win32' &&
      process.env[NATIVE_SHADOW_DISABLED_ENV_VAR] !== '1',
    sourcePath: installedAddonPath,
    version: packageVersion,
    root: getMemorizeRoot,
  };
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Return the path to a shadow copy of better_sqlite3.node, copying it once.
 * Returns null (never throws) when disabled or on any failure, so the caller
 * transparently falls back to the default addon require.
 */
export function resolveNativeBinding(
  deps: NativeAddonDeps = defaultNativeAddonDeps(),
): string | null {
  if (!deps.enabled) return null;
  try {
    const source = deps.sourcePath();
    if (!source) return null;

    const runtimeDir = path.join(deps.root(), 'runtime', deps.version());
    const target = path.join(runtimeDir, 'better_sqlite3.node');

    const needsCopy =
      !fs.existsSync(target) || sha256(target) !== sha256(source);
    if (needsCopy) {
      fs.mkdirSync(runtimeDir, { recursive: true });
      const tmp = path.join(runtimeDir, `.better_sqlite3.node.${process.pid}.tmp`);
      fs.copyFileSync(source, tmp);
      const fd = fs.openSync(tmp, 'r+');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmp, target); // atomic swap into place
    }
    pruneStaleRuntime(runtimeDir);
    return target;
  } catch {
    return null;
  }
}

/**
 * Best-effort GC of sibling runtime/<other-version> dirs plus any orphaned
 * temp files left in the current dir by a crash between copy and rename. A dir
 * still locked by an older running process can't be removed on Windows —
 * swallow and leave it for a later run once that process exits.
 *
 * Cross-version prune race (accepted): during an upgrade an old-version process
 * could delete runtime/<new-version> in the tiny gap after the new process
 * created it but before its `new Database` maps and OS-locks the addon, making
 * the new open throw ENOENT. The window is vanishingly small and the next open
 * self-heals via re-copy, so we deliberately don't guard it here — a "fix"
 * (e.g. locking the whole runtime root) would trade this for worse contention.
 */
function pruneStaleRuntime(currentDir: string): void {
  try {
    const runtimeRoot = path.dirname(currentDir);
    for (const entry of fs.readdirSync(runtimeRoot)) {
      const dir = path.join(runtimeRoot, entry);
      if (dir === currentDir) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // locked by a live older process — cleaned on a later run
      }
    }
  } catch {
    // runtime root missing/unreadable — nothing to prune
  }

  // Sweep orphaned copy-in-progress temp files (a crash between copyFileSync
  // and renameSync leaves a multi-MB .better_sqlite3.node.<pid>.tmp behind).
  try {
    for (const entry of fs.readdirSync(currentDir)) {
      if (!entry.startsWith('.better_sqlite3.node.') || !entry.endsWith('.tmp')) {
        continue;
      }
      try {
        fs.rmSync(path.join(currentDir, entry), { force: true });
      } catch {
        // a concurrent process's in-flight tmp being renamed away is harmless
      }
    }
  } catch {
    // current dir missing/unreadable — nothing to sweep
  }
}
