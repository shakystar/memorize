import type { BaseEntity, EntityId, ISODateString } from '../common.js';

export type SyncStatus = 'idle' | 'syncing' | 'conflicted' | 'offline';

export interface ProjectSyncState extends BaseEntity {
  projectId: EntityId;
  remoteProjectId?: string;
  syncEnabled: boolean;
  lastPushedEventId?: string;
  lastPulledEventId?: string;
  lastSyncAt?: ISODateString;
  syncStatus: SyncStatus;
}
