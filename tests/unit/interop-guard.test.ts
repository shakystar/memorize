import { afterEach, describe, expect, it } from 'vitest';

import {
  assertNotWindowsInteropLeak,
  isWindowsInstallUnderLinux,
  renderWindowsInteropError,
} from '../../src/cli/interop-guard.js';

describe('isWindowsInstallUnderLinux - WSL PATH-leak detection', () => {
  it('flags a Linux process executing a script on a Windows drive mount', () => {
    expect(
      isWindowsInstallUnderLinux(
        'linux',
        '/mnt/c/Users/me/AppData/Roaming/npm/node_modules/@shakystar/memorize/dist/cli/index.js',
      ),
    ).toBe(true);
  });

  it('accepts any drive letter, either case', () => {
    expect(isWindowsInstallUnderLinux('linux', '/mnt/d/tools/cli.js')).toBe(true);
    expect(isWindowsInstallUnderLinux('linux', '/MNT/C/tools/cli.js')).toBe(true);
  });

  it('passes a genuine Linux install', () => {
    expect(
      isWindowsInstallUnderLinux(
        'linux',
        '/home/ubuntu/.npm-global/lib/node_modules/@shakystar/memorize/dist/cli/index.js',
      ),
    ).toBe(false);
  });

  it('never fires off Linux — /mnt-looking paths are fine elsewhere', () => {
    expect(isWindowsInstallUnderLinux('win32', '/mnt/c/anything.js')).toBe(false);
    expect(isWindowsInstallUnderLinux('darwin', '/mnt/c/anything.js')).toBe(false);
  });

  it('does not fire on a missing script path', () => {
    expect(isWindowsInstallUnderLinux('linux', undefined)).toBe(false);
    expect(isWindowsInstallUnderLinux('linux', '')).toBe(false);
  });

  it('does not fire on non-mount Linux paths that merely contain "mnt"', () => {
    expect(isWindowsInstallUnderLinux('linux', '/opt/mnt/c/cli.js')).toBe(false);
    expect(isWindowsInstallUnderLinux('linux', '/mnt/data/cli.js')).toBe(false);
  });
});

describe('renderWindowsInteropError', () => {
  it('names the offending path, the fix, and the bypass', () => {
    const message = renderWindowsInteropError('/mnt/c/npm/memorize/cli.js');
    expect(message).toContain('/mnt/c/npm/memorize/cli.js');
    expect(message).toContain('npm i -g @shakystar/memorize');
    expect(message).toContain('MEMORIZE_ALLOW_WINDOWS_INTEROP=1');
  });
});

describe('assertNotWindowsInteropLeak', () => {
  afterEach(() => {
    delete process.env.MEMORIZE_ALLOW_WINDOWS_INTEROP;
  });

  it('is a no-op in this test environment (argv is not a /mnt path on linux)', () => {
    expect(() => assertNotWindowsInteropLeak()).not.toThrow();
  });

  it('is a no-op when explicitly bypassed', () => {
    process.env.MEMORIZE_ALLOW_WINDOWS_INTEROP = '1';
    expect(() => assertNotWindowsInteropLeak()).not.toThrow();
  });
});
