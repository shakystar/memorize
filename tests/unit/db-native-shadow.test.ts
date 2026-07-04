import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRequire } from 'node:module';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAll, getDb } from '../../src/storage/db.js';
import { NATIVE_SHADOW_DISABLED_ENV_VAR } from '../../src/storage/native-addon.js';

const require = createRequire(import.meta.url); // ESM has no bare require
const VALID_PROJECT_ID = 'proj_l2x_abcdef12';

let tmpRoot: string;
let prevRoot: string | undefined;
let prevDisabled: string | undefined;

beforeEach(() => {
  prevRoot = process.env.MEMORIZE_ROOT;
  prevDisabled = process.env[NATIVE_SHADOW_DISABLED_ENV_VAR];
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memorize-shadow-'));
  process.env.MEMORIZE_ROOT = tmpRoot;
  delete process.env[NATIVE_SHADOW_DISABLED_ENV_VAR]; // exercise the real path
});

afterEach(() => {
  closeAll();
  if (prevRoot === undefined) delete process.env.MEMORIZE_ROOT;
  else process.env.MEMORIZE_ROOT = prevRoot;
  if (prevDisabled === undefined) delete process.env[NATIVE_SHADOW_DISABLED_ENV_VAR];
  else process.env[NATIVE_SHADOW_DISABLED_ENV_VAR] = prevDisabled;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // win32: a native addon loaded from inside tmpRoot (the shadow copy, or
    // the lock-physics fixture's `loaded.node`) stays locked for the life of
    // this test process even after Database#close() — `force: true` does not
    // suppress EPERM. Best-effort cleanup, same tolerance as
    // pruneStaleRuntime in native-addon.ts; the OS reclaims the temp dir.
  }
});

describe('db open() native-addon shadow', () => {
  it('win32: getDb creates and uses the runtime shadow copy', () => {
    if (process.platform !== 'win32') return;
    const db = getDb(VALID_PROJECT_ID);
    expect(db.prepare('SELECT 1 AS n').get()).toEqual({ n: 1 });
    const runtime = path.join(tmpRoot, 'runtime');
    expect(fs.existsSync(runtime)).toBe(true);
    // exactly one version dir, containing the addon
    const [ver] = fs.readdirSync(runtime);
    expect(fs.existsSync(path.join(runtime, ver!, 'better_sqlite3.node'))).toBe(true);
  });

  it('non-win32: getDb works and creates NO runtime dir (fallback path)', () => {
    if (process.platform === 'win32') return;
    const db = getDb(VALID_PROJECT_ID);
    expect(db.prepare('SELECT 1 AS n').get()).toEqual({ n: 1 });
    expect(fs.existsSync(path.join(tmpRoot, 'runtime'))).toBe(false);
  });

  it('win32 lock physics: a loaded addon locks, an unloaded copy does not', () => {
    if (process.platform !== 'win32') return;
    // Prove the mechanism against temp copies (no node_modules mutation):
    // resolveNativeBinding makes us load the SHADOW, so the INSTALLED file
    // plays the unloaded-copy role and stays overwritable.
    const realAddon = require.resolve('better-sqlite3/build/Release/better_sqlite3.node');
    const loaded = path.join(tmpRoot, 'loaded.node');
    const unloaded = path.join(tmpRoot, 'unloaded.node');
    fs.copyFileSync(realAddon, loaded);
    fs.copyFileSync(realAddon, unloaded);

    const mem = new Database(':memory:', { nativeBinding: loaded });
    try {
      // The unloaded copy can be rewritten in place while `loaded` is live.
      expect(() =>
        fs.writeFileSync(unloaded, fs.readFileSync(unloaded)),
      ).not.toThrow();
      // The loaded copy is locked by Windows (EBUSY/EPERM/EACCES depending on
      // the write path — all mean "held by a loaded module").
      expect(() =>
        fs.writeFileSync(loaded, fs.readFileSync(loaded)),
      ).toThrow(/EBUSY|EPERM|EACCES/);
    } finally {
      mem.close();
    }
  });
});
