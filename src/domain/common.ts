export const CURRENT_SCHEMA_VERSION = '0.1.0';

export const ACTOR_SYSTEM = 'system';
export const ACTOR_USER = 'user';
export const ACTOR_NEXT_AGENT = 'next-agent';

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
