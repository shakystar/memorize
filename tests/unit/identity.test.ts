import { afterEach, describe, expect, it } from 'vitest';

import { PERSONAL_STORE_ID } from '../../src/domain/common.js';
import {
  DEFAULT_ACCOUNT_ID,
  isDefaultAccount,
  resolveActiveAccount,
} from '../../src/domain/identity/account.js';
import {
  accountOfPersonalStore,
  getPersonalStoreId,
  isPersonalStoreId,
} from '../../src/domain/identity/personal-store.js';

afterEach(() => {
  delete process.env.MEMORIZE_ACCOUNT;
});

describe('account identity', () => {
  it('exposes a fixed default-account sentinel', () => {
    expect(DEFAULT_ACCOUNT_ID).toBe('local_default');
    expect(isDefaultAccount(DEFAULT_ACCOUNT_ID)).toBe(true);
    expect(isDefaultAccount('acc_abc')).toBe(false);
  });

  it('resolveActiveAccount defaults to the local account and honors the env override', () => {
    delete process.env.MEMORIZE_ACCOUNT;
    expect(resolveActiveAccount()).toBe(DEFAULT_ACCOUNT_ID);
    process.env.MEMORIZE_ACCOUNT = 'acc_abc';
    expect(resolveActiveAccount()).toBe('acc_abc');
  });

  it('rejects an invalid MEMORIZE_ACCOUNT override', () => {
    process.env.MEMORIZE_ACCOUNT = 'Bad Id';
    expect(() => resolveActiveAccount()).toThrow();
  });
});

describe('personal-store id family', () => {
  it('default account keeps the legacy personal id (no re-keying)', () => {
    expect(getPersonalStoreId(DEFAULT_ACCOUNT_ID)).toBe(PERSONAL_STORE_ID);
    expect(getPersonalStoreId(DEFAULT_ACCOUNT_ID)).toBe('personal_self');
  });

  it('a non-default account gets a distinct per-account id', () => {
    expect(getPersonalStoreId('acc_abc')).toBe('personal_acc_abc');
  });

  it('isPersonalStoreId recognizes the whole family, not just the default', () => {
    expect(isPersonalStoreId('personal_self')).toBe(true);
    expect(isPersonalStoreId('personal_acc_abc')).toBe(true);
    expect(isPersonalStoreId('proj_abc')).toBe(false);
    expect(isPersonalStoreId(123)).toBe(false);
    expect(isPersonalStoreId(undefined)).toBe(false);
  });

  it('accountOfPersonalStore inverts getPersonalStoreId', () => {
    expect(accountOfPersonalStore('personal_self')).toBe(DEFAULT_ACCOUNT_ID);
    expect(accountOfPersonalStore('personal_acc_abc')).toBe('acc_abc');
    for (const account of ['local_default', 'acc_abc', 'acc_9x_y']) {
      expect(accountOfPersonalStore(getPersonalStoreId(account))).toBe(account);
    }
  });
});
