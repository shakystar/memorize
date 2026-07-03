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
  /**
   * Workspace membership CACHE (W-a, SoT-022) — control-plane facts, NOT truth.
   * When `remoteProjectId` is a server-minted `wsp_`, these mirror the gateway's
   * role + reachability so status/labeling need no round-trip; refreshed from the
   * gateway on sync and never authoritative, never event-sourced. Absent for a
   * plain `proj_` relay sync (their presence is what marks a workspace binding).
   */
  workspaceRole?: 'owner' | 'member';
  inviteReachable?: boolean;
  /**
   * The `wsp_` this project's `proj_` id was last registered into as a source
   * store (Hub member attribution, hub workspace.md §Source stores). A cache
   * like the role fields: it skips the re-register call at sync boundaries and
   * self-invalidates by comparison against `remoteProjectId` when the binding
   * changes. Absent = not yet registered (healed at the next sync boundary).
   */
  sourceStoreRegisteredWith?: string;
  /**
   * base64 AES-256 key for client-side E2E encryption of synced event payloads
   * (#182). When present, the sync push/pull boundary encrypts each event's
   * `payload` before it leaves the machine and decrypts it on arrival; absent =
   * plaintext sync (unchanged). Local-only and NEVER synced: it lives in this
   * sync state, and `buildPushPayload` already excludes `sync.state.updated`
   * events from the wire, so the relay never receives it.
   */
  encryptionKey?: string;
}
