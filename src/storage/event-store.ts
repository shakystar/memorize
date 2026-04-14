import fs from 'node:fs/promises';
import path from 'node:path';

import { createId, CURRENT_SCHEMA_VERSION, nowIso } from '../domain/common.js';
import type {
  DomainEvent,
  DomainEventPayload,
  DomainEventType,
} from '../domain/events.js';
import { appendLine, ensureDir } from './fs-utils.js';
import { getEventsFile, getProjectRoot } from './path-resolver.js';

export interface AppendEventInput<TPayload extends DomainEventPayload> {
  type: DomainEventType;
  projectId: string;
  scopeType: DomainEvent['scopeType'];
  scopeId: string;
  actor: string;
  payload: TPayload;
}

function dateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export async function ensureProjectDirectories(projectId: string): Promise<void> {
  const projectRoot = getProjectRoot(projectId);
  await Promise.all(
    [
      projectRoot,
      path.join(projectRoot, 'events'),
      path.join(projectRoot, 'tasks'),
      path.join(projectRoot, 'workstreams'),
      path.join(projectRoot, 'handoffs'),
      path.join(projectRoot, 'checkpoints'),
      path.join(projectRoot, 'conflicts'),
      path.join(projectRoot, 'rules'),
      path.join(projectRoot, 'topics'),
      path.join(projectRoot, 'sync'),
    ].map((dirPath) => ensureDir(dirPath)),
  );
}

export async function appendEvent<TPayload extends DomainEventPayload>(
  input: AppendEventInput<TPayload>,
): Promise<DomainEvent<TPayload>> {
  const timestamp = nowIso();
  const event: DomainEvent<TPayload> = {
    id: createId('evt'),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    type: input.type,
    projectId: input.projectId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    actor: input.actor,
    payload: input.payload,
  };

  await ensureProjectDirectories(input.projectId);
  await appendLine(
    getEventsFile(input.projectId, dateKey()),
    JSON.stringify(event),
  );
  return event;
}

export async function readEvents(projectId: string): Promise<DomainEvent[]> {
  const eventsDir = path.join(getProjectRoot(projectId), 'events');
  try {
    const files = (await fs.readdir(eventsDir))
      .filter((file) => file.endsWith('.ndjson'))
      .sort();
    const events: DomainEvent[] = [];

    for (const file of files) {
      const raw = await fs.readFile(path.join(eventsDir, file), 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        events.push(JSON.parse(trimmed) as DomainEvent);
      }
    }

    return events;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
