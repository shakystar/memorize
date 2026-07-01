import { assertValidId } from '../common.js';

/**
 * The reserved LOCAL account used before any server login (OAuth/Hub). memorize
 * is local-first: like git commits before `git remote add`, a user has a local
 * account identity long before the server mints an `acc_…` (Hub SoT H050). All
 * pre-login data lives under this account; at login it attaches to the
 * server-issued accountId (a later milestone, W1). It is deliberately a fixed
 * SENTINEL, never minted, so it can never collide with a server `acc_…`.
 */
export const DEFAULT_ACCOUNT_ID = 'local_default';

export function isDefaultAccount(accountId: string): boolean {
  return accountId === DEFAULT_ACCOUNT_ID;
}

/**
 * The active account whose stores (personal + projects) this process reads and
 * writes — the account axis is orthogonal to the folder→project binding
 * (memorize SoT-020). M1 is single-account: an explicit `MEMORIZE_ACCOUNT` env
 * override (tests / advanced use) falls back to the default local account.
 * Persistent account switching (an `active-account.json` + an `account` CLI)
 * arrives with server login (W1); until then there is exactly one account and no
 * on-disk active-account state is read here (which also keeps this module free of
 * any path-resolver dependency, so there is no import cycle).
 */
export function resolveActiveAccount(): string {
  const override = process.env.MEMORIZE_ACCOUNT?.trim();
  if (override) {
    assertValidId(override, 'accountId');
    return override;
  }
  return DEFAULT_ACCOUNT_ID;
}
