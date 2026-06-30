export const CURRENT_SCHEMA_VERSION = '0.1.0';

export const ACTOR_SYSTEM = 'system';
export const ACTOR_USER = 'user';
export const ACTOR_NEXT_AGENT = 'next-agent';

/**
 * Reserved store id for the global/personal memory pipeline (Path A). Personal
 * memory is a permanent, account-level axis ABOVE the project axis — it is not a
 * project and not a `scopeType` value. It reuses the per-store event-log +
 * projection + consolidation machinery under a fixed id, but lives in its OWN
 * host-level directory (`~/.memorize/personal/`, see getPersonalRoot) so it is
 * invisible to project enumeration (listProjects) and structurally excluded from
 * sync/teams (see assertNotPersonalStore in sync-service). The id matches
 * ID_PATTERN so it flows through assertValidId unchanged; no minted `proj_…` id
 * can collide with it.
 */
export const PERSONAL_STORE_ID = 'personal_self';

/** True iff `id` is the reserved global/personal memory store id. */
export function isPersonalStoreId(id: unknown): boolean {
  return id === PERSONAL_STORE_ID;
}

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
