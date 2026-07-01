import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ACCOUNT_ID } from '../../src/domain/identity/account.js';
import {
  getAccountRoot,
  getAccountsRoot,
  getPersonalRoot,
  getProjectDbFile,
  getProjectRoot,
  getProjectsRoot,
} from '../../src/storage/path-resolver.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memorize-pathres-'));
  process.env.MEMORIZE_ROOT = root;
  delete process.env.MEMORIZE_ACCOUNT;
});

afterEach(() => {
  delete process.env.MEMORIZE_ROOT;
  delete process.env.MEMORIZE_ACCOUNT;
  rmSync(root, { recursive: true, force: true });
});

describe('path-resolver account layer', () => {
  it('composes account-scoped roots for the active (default) account', () => {
    expect(getAccountsRoot()).toBe(join(root, 'accounts'));
    expect(getAccountRoot(DEFAULT_ACCOUNT_ID)).toBe(
      join(root, 'accounts', 'local_default'),
    );
    expect(getProjectsRoot()).toBe(
      join(root, 'accounts', 'local_default', 'projects'),
    );
    expect(getPersonalRoot()).toBe(
      join(root, 'accounts', 'local_default', 'personal'),
    );
  });

  it('routes a plain project under the active account', () => {
    expect(getProjectRoot('proj_abc')).toBe(
      join(root, 'accounts', 'local_default', 'projects', 'proj_abc'),
    );
    expect(getProjectDbFile('proj_abc')).toBe(
      join(root, 'accounts', 'local_default', 'projects', 'proj_abc', 'memorize.db'),
    );
  });

  it('routes a personal store to its OWNING account, derived from the id', () => {
    expect(getProjectRoot('personal_self')).toBe(
      join(root, 'accounts', 'local_default', 'personal'),
    );
    expect(getProjectRoot('personal_acc_abc')).toBe(
      join(root, 'accounts', 'acc_abc', 'personal'),
    );
  });

  it('honors the active-account override for plain projects', () => {
    process.env.MEMORIZE_ACCOUNT = 'acc_abc';
    expect(getProjectsRoot()).toBe(
      join(root, 'accounts', 'acc_abc', 'projects'),
    );
    expect(getProjectRoot('proj_abc')).toBe(
      join(root, 'accounts', 'acc_abc', 'projects', 'proj_abc'),
    );
  });
});
