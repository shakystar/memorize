import fs from 'node:fs/promises';
import path from 'node:path';

import { createId, CURRENT_SCHEMA_VERSION, nowIso } from '../domain/common.js';
import type {
  DomainEvent,
  DomainEventPayload,
  DomainEventType,
} from '../domain/events.js';
import { appendLine, ensureDir, withFileLock } from './fs-utils.js';
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
  const eventsFile = getEventsFile(input.projectId, dateKey());
  await withFileLock(eventsFile, () =>
    appendLine(eventsFile, JSON.stringify(event)),
  );
  return event;
}

export interface EventIntegrity {
  events: DomainEvent[];
  corruptLines: { file: string; lineNumber: number; raw: string }[];
}

export async function readEventsWithIntegrity(
  projectId: string,
): Promise<EventIntegrity> {
  const eventsDir = path.join(getProjectRoot(projectId), 'events');
  const result: EventIntegrity = { events: [], corruptLines: [] };
  try {
    const files = (await fs.readdir(eventsDir))
      .filter((file) => file.endsWith('.ndjson'))
      .sort();

    for (const file of files) {
      const raw = await fs.readFile(path.join(eventsDir, file), 'utf8');
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i]!.trim();
        if (!trimmed) continue;
        try {
          result.events.push(JSON.parse(trimmed) as DomainEvent);
        } catch {
          result.corruptLines.push({
            file,
            lineNumber: i + 1,
            raw: trimmed.slice(0, 200),
          });
        }
      }
    }

    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return result;
    }
    throw error;
  }
}

export async function readEvents(projectId: string): Promise<DomainEvent[]> {
  const { events } = await readEventsWithIntegrity(projectId);
  return events;
}
