export const CURRENT_SCHEMA_VERSION = '0.1.0';

export type EntityId = string;
export type ISODateString = string;

export function nowIso(): ISODateString {
  return new Date().toISOString();
}

export function createId(prefix: string): EntityId {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

export interface BaseEntity {
  id: EntityId;
  schemaVersion: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}
