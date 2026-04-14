import fs from 'node:fs/promises';
import path from 'node:path';

import { readEvents } from '../storage/event-store.js';
import { readJson } from '../storage/fs-utils.js';
import {
  getMemoryIndexFile,
  getProjectRoot,
} from '../storage/path-resolver.js';
import { rebuildProjectProjection } from '../storage/projection-store.js';
import { getBoundProjectId, readProject } from './project-service.js';

export async function inspectProject(cwd: string): Promise<string> {
  const projectId = await getBoundProjectId(cwd);
  if (!projectId) {
    throw new Error('No project bound to current directory.');
  }
  const project = await readProject(projectId);
  return JSON.stringify(project, null, 2);
}

export async function rebuildProjection(cwd: string): Promise<string> {
  const projectId = await getBoundProjectId(cwd);
  if (!projectId) {
    throw new Error('No project bound to current directory.');
  }
  await rebuildProjectProjection(projectId);
  return 'Projection rebuild complete';
}

export async function rebuildMemoryIndex(cwd: string): Promise<string> {
  const projectId = await getBoundProjectId(cwd);
  if (!projectId) {
    throw new Error('No project bound to current directory.');
  }
  await rebuildProjectProjection(projectId);
  const memoryIndex = await readJson(getMemoryIndexFile(projectId));
  return memoryIndex ? 'Memory index rebuild complete' : 'Memory index missing';
}

export async function validateEvents(cwd: string): Promise<string> {
  const projectId = await getBoundProjectId(cwd);
  if (!projectId) {
    throw new Error('No project bound to current directory.');
  }
  const events = await readEvents(projectId);
  if (events.length === 0) {
    throw new Error('No events found for project.');
  }
  return 'Event validation passed';
}

export async function doctor(cwd: string): Promise<string> {
  const projectId = await getBoundProjectId(cwd);
  if (!projectId) {
    throw new Error('No project bound to current directory.');
  }
  const projectRoot = getProjectRoot(projectId);
  const requiredDirs = ['events', 'tasks', 'workstreams', 'rules', 'sync'];
  for (const dirName of requiredDirs) {
    await fs.access(path.join(projectRoot, dirName));
  }
  return 'Doctor check passed';
}
