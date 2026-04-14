import type { DomainEvent } from './events.js';
import type { EntityId } from './common.js';

export interface SyncPushRequest {
  projectId: EntityId;
  remoteProjectId?: string;
  sincePushedEventId?: string;
  events: DomainEvent[];
}

export interface SyncPushResponse {
  accepted: EntityId[];
  rejected: Array<{ eventId: EntityId; reason: string }>;
  lastAcceptedEventId?: EntityId;
}

export interface SyncPullRequest {
  projectId: EntityId;
  remoteProjectId: string;
  sincePulledEventId?: string;
}

export interface SyncPullResponse {
  events: DomainEvent[];
  lastRemoteEventId?: EntityId;
}

export interface SyncQueueSnapshot {
  outboundPendingCount: number;
  inboundPendingCount: number;
  lastPushedEventId?: string;
  lastPulledEventId?: string;
}
