import type { BaseEntity, EntityId, ISODateString } from '../common.js';

export type SyncStatus = 'idle' | 'syncing' | 'conflicted' | 'offline';

/**
 * Persisted transport location so background auto-sync (P3-b) knows WHERE to
 * sync without a CLI `--remote-path` flag. `file` points at a shared directory
 * (cloud-sync folder / NFS); `http` points at an optional relay server (P3-b-2)
 * for machines that do NOT share a filesystem. Both are store-and-forward; the
 * relay is OPTIONAL (local-first preserved — no transport = single-machine).
 */
export type SyncTransportConfig =
  | { type: 'file'; location: string }
  | { type: 'http'; url: string; token?: string };

export interface ProjectSyncState extends BaseEntity {
  projectId: EntityId;
  remoteProjectId?: string;
  syncEnabled: boolean;
  /** Where auto-sync pushes/pulls. Absent = single-machine (no auto-sync). */
  syncTransport?: SyncTransportConfig;
  lastPushedEventId?: string;
  lastPulledEventId?: string;
  lastSyncAt?: ISODateString;
  syncStatus: SyncStatus;
}
