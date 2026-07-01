export const CURRENT_SCHEMA_VERSION = '0.1.0';

export const ACTOR_SYSTEM = 'system';
export const ACTOR_USER = 'user';
export const ACTOR_NEXT_AGENT = 'next-agent';

/**
 * Reserved personal-store id for the DEFAULT (pre-login) local account. Personal
 * memory is a permanent, account-level axis ABOVE the project axis — it is not a
 * project and not a `scopeType` value. Each account has its own personal store
 * (see `domain/identity/personal-store.ts` for the per-account id family and the
 * structural `isPersonalStoreId`); this legacy id is the default account's member
 * of that family, kept fixed so existing on-disk data needs no re-keying. It
 * reuses the per-store event-log + projection + consolidation machinery, lives in
 * its account's `accounts/<id>/personal/` directory (see getPersonalRoot) so it
 * is invisible to project enumeration (listProjects) and structurally excluded
 * from cross-account sync (assertNotPersonalStore). The id matches ID_PATTERN so
 * it flows through assertValidId unchanged; no minted `proj_…` id can collide.
 */
export const PERSONAL_STORE_ID = 'personal_self';

export type EntityId = string;
export type ISODateString = string;

export const ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
export const MAX_ID_LENGTH = 128;

export function nowIso(): ISODateString {
  return new Date().toISOString();
}

export function createId(prefix: string): EntityId {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

export function isValidId(value: unknown): value is EntityId {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    ID_PATTERN.test(value)
  );
}

export function assertValidId(
  value: unknown,
  kind: string = 'id',
): asserts value is EntityId {
  if (!isValidId(value)) {
    throw new Error(
      `Invalid ${kind}: ${JSON.stringify(value)} (must match ${ID_PATTERN})`,
    );
  }
}

export interface BaseEntity {
  id: EntityId;
  schemaVersion: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}
