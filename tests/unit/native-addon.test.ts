import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultNativeAddonDeps,
  resolveNativeBinding,
  type NativeAddonDeps,
} from '../../src/storage/native-addon.js';

let tmp: string;
let source: string;

const SOURCE_BYTES = Buffer.from('fake-addon-bytes-v1');

function sha(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function deps(overrides: Partial<NativeAddonDeps> = {}): NativeAddonDeps {
  return {
    enabled: true,
    sourcePath: () => source,
    version: () => '9.9.9',
    root: () => tmp,
    ...overrides,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memorize-nativeaddon-'));
  source = path.join(tmp, 'src', 'better_sqlite3.node');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, SOURCE_BYTES);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveNativeBinding', () => {
  it('returns null when disabled (non-win32 / test off-switch)', () => {
    expect(resolveNativeBinding(deps({ enabled: false }))).toBeNull();
    // nothing copied
    expect(fs.existsSync(path.join(tmp, 'runtime'))).toBe(false);
  });

  it('returns null when the source addon cannot be found', () => {
    expect(resolveNativeBinding(deps({ sourcePath: () => null }))).toBeNull();
  });

  it('copies the addon once to runtime/<version>/ and returns its path', () => {
    const target = resolveNativeBinding(deps());
    expect(target).toBe(
      path.join(tmp, 'runtime', '9.9.9', 'better_sqlite3.node'),
    );
    expect(fs.existsSync(target!)).toBe(true);
    expect(sha(target!)).toBe(sha(source));
  });

  it('reuses an existing target whose hash matches (no re-copy)', () => {
    const first = resolveNativeBinding(deps())!;
    const before = fs.statSync(first).mtimeMs;
    const second = resolveNativeBinding(deps())!;
    expect(second).toBe(first);
    expect(fs.statSync(second).mtimeMs).toBe(before); // untouched
  });

  it('re-copies when the target hash differs from the source', () => {
    const target = resolveNativeBinding(deps())!;
    fs.writeFileSync(target, Buffer.from('stale-different-bytes'));
    const again = resolveNativeBinding(deps())!;
    expect(sha(again)).toBe(sha(source)); // refreshed to match source
  });

  it('prunes sibling runtime/<other-version> dirs but keeps the current one', () => {
    const stale = path.join(tmp, 'runtime', '1.0.0');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'better_sqlite3.node'), Buffer.from('old'));
    resolveNativeBinding(deps());
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'runtime', '9.9.9'))).toBe(true);
  });

  it('returns null (never throws) when the runtime dir cannot be created', () => {
    // root points UNDER a regular file → mkdirSync fails with ENOTDIR/EEXIST
    const asFile = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(asFile, 'x');
    expect(resolveNativeBinding(deps({ root: () => asFile }))).toBeNull();
  });
});

describe('defaultNativeAddonDeps', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.MEMORIZE_NATIVE_SHADOW_DISABLED;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.MEMORIZE_NATIVE_SHADOW_DISABLED;
    } else {
      process.env.MEMORIZE_NATIVE_SHADOW_DISABLED = savedEnv;
    }
  });

  it('is disabled off win32 regardless of env', () => {
    if (process.platform === 'win32') return; // asserted on non-win32 hosts
    expect(defaultNativeAddonDeps().enabled).toBe(false);
  });

  it('is enabled on win32 when the disable env var is unset', () => {
    if (process.platform !== 'win32') return; // asserted on win32 hosts
    delete process.env.MEMORIZE_NATIVE_SHADOW_DISABLED;
    expect(defaultNativeAddonDeps().enabled).toBe(true);
  });

  it('is disabled on win32 when the disable env var is "1"', () => {
    if (process.platform !== 'win32') return; // asserted on win32 hosts
    process.env.MEMORIZE_NATIVE_SHADOW_DISABLED = '1';
    expect(defaultNativeAddonDeps().enabled).toBe(false);
  });
});
