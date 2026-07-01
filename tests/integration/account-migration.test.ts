import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateToAccountLayout } from '../../src/storage/account-migration.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memorize-acctmig-'));
  process.env.MEMORIZE_ROOT = root;
});

afterEach(() => {
  delete process.env.MEMORIZE_ROOT;
  rmSync(root, { recursive: true, force: true });
});

const accountRoot = () => join(root, 'accounts', 'local_default');

describe('account-layout migration', () => {
  it('moves legacy projects/ and personal/ under the default account, losslessly', () => {
    mkdirSync(join(root, 'projects', 'proj_a'), { recursive: true });
    writeFileSync(join(root, 'projects', 'proj_a', 'memorize.db'), 'DBDATA');
    mkdirSync(join(root, 'personal'), { recursive: true });
    writeFileSync(join(root, 'personal', 'memorize.db'), 'PERSONAL');
    // A host-level (non-account) file must be left where it is.
    writeFileSync(join(root, 'credentials'), 'CRED');

    migrateToAccountLayout();

    expect(
      readFileSync(join(accountRoot(), 'projects', 'proj_a', 'memorize.db'), 'utf8'),
    ).toBe('DBDATA');
    expect(
      readFileSync(join(accountRoot(), 'personal', 'memorize.db'), 'utf8'),
    ).toBe('PERSONAL');
    expect(existsSync(join(root, 'projects'))).toBe(false);
    expect(existsSync(join(root, 'personal'))).toBe(false);
    expect(readFileSync(join(root, 'credentials'), 'utf8')).toBe('CRED');
  });

  it('is a no-op on a fresh install and idempotent on re-run', () => {
    migrateToAccountLayout();
    expect(existsSync(join(root, 'accounts'))).toBe(false);

    mkdirSync(join(root, 'personal'), { recursive: true });
    writeFileSync(join(root, 'personal', 'x'), 'P');
    migrateToAccountLayout();
    migrateToAccountLayout(); // second run must not throw or clobber

    expect(
      readFileSync(join(accountRoot(), 'personal', 'x'), 'utf8'),
    ).toBe('P');
  });

  it('moves personal independently when projects is already migrated (partial state)', () => {
    mkdirSync(join(accountRoot(), 'projects'), { recursive: true });
    mkdirSync(join(root, 'personal'), { recursive: true });
    writeFileSync(join(root, 'personal', 'y'), 'Y');

    migrateToAccountLayout();

    expect(readFileSync(join(accountRoot(), 'personal', 'y'), 'utf8')).toBe('Y');
    expect(existsSync(join(root, 'personal'))).toBe(false);
  });
});
