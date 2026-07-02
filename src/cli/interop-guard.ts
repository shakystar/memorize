import { realpathSync } from 'node:fs';

/**
 * WSL appends the Windows PATH by default (interop appendWindowsPath), so a
 * Windows-side global npm install of memorize can shadow - or substitute for -
 * a Linux install and end up executed by Linux node from /mnt/<drive>. With a
 * native dependency (better-sqlite3) that combination is never valid, and it
 * does not fail loudly: the observed failure mode is a silent hang with zero
 * output (W3 live dogfood, 2026-07-03). Detect the mismatch at the entry point
 * and refuse to start with an actionable message instead.
 */

/** True when a Linux process is executing a script living on a Windows drive mount. */
export function isWindowsInstallUnderLinux(
  platform: NodeJS.Platform,
  scriptPath: string | undefined,
): boolean {
  if (platform !== 'linux' || !scriptPath) return false;
  return /^\/mnt\/[a-z]\//i.test(scriptPath);
}

export function renderWindowsInteropError(scriptPath: string): string {
  return [
    `This memorize binary lives on a Windows mount (${scriptPath}) but is`,
    'being run by Linux node. The Windows PATH leaking into WSL usually causes',
    'this; native modules cannot cross that boundary, and the CLI can hang',
    'silently instead of failing.',
    '',
    'Fix: install a Linux copy and make sure it wins over /mnt/* in PATH:',
    '    npm i -g @shakystar/memorize',
    '    hash -r    # `which memorize` must not print a /mnt/... path',
    '',
    'Set MEMORIZE_ALLOW_WINDOWS_INTEROP=1 to bypass this check.',
  ].join('\n');
}

/**
 * Entry-point guard: throws (so the CLI exits 1 with the message) unless the
 * check passes or is explicitly bypassed. `realpathSync` sees through a Linux
 * symlink that points into /mnt/*; an unresolvable argv falls back to the raw
 * path rather than failing the guard itself.
 */
export function assertNotWindowsInteropLeak(): void {
  if (process.env.MEMORIZE_ALLOW_WINDOWS_INTEROP === '1') return;
  const raw = process.argv[1];
  let resolved = raw;
  try {
    if (raw) resolved = realpathSync(raw);
  } catch {
    // Deleted or unreadable argv path - judge the raw value instead.
  }
  if (
    isWindowsInstallUnderLinux(process.platform, raw) ||
    isWindowsInstallUnderLinux(process.platform, resolved)
  ) {
    throw new Error(renderWindowsInteropError(resolved ?? raw ?? ''));
  }
}
