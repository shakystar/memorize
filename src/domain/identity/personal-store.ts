import { PERSONAL_STORE_ID } from '../common.js';
import { DEFAULT_ACCOUNT_ID, isDefaultAccount } from './account.js';

/**
 * The reserved namespace prefix for personal stores. Every account's personal
 * store id lives in this family; the default (pre-login) account keeps the legacy
 * fixed id `personal_self` (which is itself in the family) so existing on-disk
 * data needs no re-keying.
 */
const PERSONAL_STORE_PREFIX = 'personal_';

/**
 * The personal-store id for an account. Default account → the legacy
 * `personal_self`; every other account → `personal_<accountId>`. Path isolation
 * (accounts/<id>/personal, see path-resolver) plus a DISTINCT id per account keep
 * accounts' personal memory apart, and mirror Hub's server-minted `psm_` (one per
 * account, Hub SoT H050) so a later sync binding (W1) is purely additive.
 */
export function getPersonalStoreId(accountId: string): string {
  return isDefaultAccount(accountId)
    ? PERSONAL_STORE_ID
    : `${PERSONAL_STORE_PREFIX}${accountId}`;
}

/**
 * Structural predicate: is `id` ANY account's personal-store id (the reserved
 * `personal_` family), not just the legacy default? Sync exclusion and path
 * resolution route every account's personal store through this — replacing the
 * old single-id equality now that personal stores are per-account.
 */
export function isPersonalStoreId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(PERSONAL_STORE_PREFIX);
}

/**
 * The account that owns a personal-store id (inverse of getPersonalStoreId). The
 * legacy `personal_self` maps back to the default account; `personal_<accountId>`
 * strips the prefix. Lets path resolution derive the account from the store id
 * alone, with no ambient active-account coupling.
 */
export function accountOfPersonalStore(personalStoreId: string): string {
  if (personalStoreId === PERSONAL_STORE_ID) return DEFAULT_ACCOUNT_ID;
  return personalStoreId.slice(PERSONAL_STORE_PREFIX.length);
}
