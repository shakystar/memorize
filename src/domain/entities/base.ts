import {
  createId,
  CURRENT_SCHEMA_VERSION,
  nowIso,
  type BaseEntity,
} from '../common.js';

export type ArtifactScope =
  | 'policy'
  | 'project'
  | 'workstream'
  | 'task'
  | 'session';

export type NewEntityFields = Omit<
  BaseEntity,
  'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'
>;

export function baseEntity(prefix: string): BaseEntity & NewEntityFields {
  const timestamp = nowIso();
  return {
    id: createId(prefix),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
