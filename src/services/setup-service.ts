import fs from 'node:fs/promises';
import path from 'node:path';

import type { Project, Rule } from '../domain/entities.js';
import { createConflict, createRule } from '../domain/entities.js';
import { nowIso } from '../domain/common.js';
import { isEnoent } from '../storage/fs-utils.js';
import { appendEvents } from '../storage/event-store.js';
import type { AppendEventInput } from '../storage/event-store.js';
import type { DomainEventPayload } from '../domain/events.js';
import {
  listImportedRules,
  rebuildProjectProjection,
} from './projection-store.js';
import {
  createProject,
  getBoundProjectId,
  readProject,
} from './project-service.js';

interface DiscoverableContextFile {
  path: string;
  title: string;
  body: string;
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

async function discoverContextFiles(
  rootPath: string,
): Promise<DiscoverableContextFile[]> {
  const discovered: DiscoverableContextFile[] = [];

  for (const candidate of [
    { fileName: 'AGENTS.md', title: 'Imported AGENTS.md' },
    { fileName: 'CLAUDE.md', title: 'Imported CLAUDE.md' },
    { fileName: 'GEMINI.md', title: 'Imported GEMINI.md' },
    { fileName: '.cursorrules', title: 'Imported .cursorrules' },
  ]) {
    const body = await readIfExists(path.join(rootPath, candidate.fileName));
    if (body?.trim()) {
      discovered.push({
        path: candidate.fileName,
        title: candidate.title,
        body: body.trim(),
      });
    }
  }

  const cursorRulesDir = path.join(rootPath, '.cursor', 'rules');
  try {
    const entries = (await fs.readdir(cursorRulesDir))
      .filter((entry) => entry.endsWith('.mdc') || entry.endsWith('.md'))
      .sort();

    for (const entry of entries) {
      const body = await fs.readFile(path.join(cursorRulesDir, entry), 'utf8');
      if (!body.trim()) continue;
      discovered.push({
        path: path.join('.cursor', 'rules', entry),
        title: `Imported ${entry}`,
        body: body.trim(),
      });
    }
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  return discovered;
}

export async function importContextFiles(project: Project): Promise<number> {
  const files = await discoverContextFiles(project.rootPath);

  // Idempotent re-import: key existing imported rules by title so a re-run
  // upserts in place instead of minting duplicate rule ids. Historical
  // duplicates (pre-fix re-runs) — reuse the most recently updated one and
  // leave the rest untouched (cleanup is out of scope).
  const existingByTitle = new Map<string, Rule>();
  for (const rule of listImportedRules(project.id)) {
    const prev = existingByTitle.get(rule.title);
    if (!prev || rule.updatedAt > prev.updatedAt) {
      existingByTitle.set(rule.title, rule);
    }
  }

  const importedRules: Rule[] = [];
  const events: AppendEventInput<DomainEventPayload>[] = [];

  for (const file of files) {
    const existing = existingByTitle.get(file.title);
    if (existing && existing.body === file.body) {
      continue; // unchanged — no event, rule stays as-is
    }
    const rule: Rule = existing
      ? {
          ...existing,
          body: file.body,
          updatedAt: nowIso(),
          updatedBy: 'system-import',
        }
      : createRule({
          scopeType: 'project',
          scopeId: project.id,
          title: file.title,
          body: file.body,
          updatedBy: 'system-import',
          source: 'imported',
        });

    events.push({
      type: 'rule.upserted',
      projectId: project.id,
      scopeType: 'project',
      scopeId: project.id,
      actor: 'system-import',
      payload: rule,
    });
    importedRules.push(rule);
  }

  if (importedRules.length > 0) {
    events.push({
      type: 'project.updated',
      projectId: project.id,
      scopeType: 'project',
      scopeId: project.id,
      actor: 'system-import',
      payload: {
        importedContextCount: importedRules.length,
      } satisfies Partial<Project>,
    });
  }

  const loweredRules = importedRules.map((rule) => ({
    ruleId: rule.id,
    body: rule.body.toLowerCase(),
  }));
  const hasSmallCommits = loweredRules.some((rule) =>
    rule.body.includes('small commits') ||
    rule.body.includes('commits small') ||
    rule.body.includes('keep commits small'),
  );
  const hasSquashCommit = loweredRules.some((rule) =>
    rule.body.includes('squash') ||
    rule.body.includes('one final commit'),
  );

  if (hasSmallCommits && hasSquashCommit) {
    const conflict = createConflict({
      projectId: project.id,
      scopeType: 'rule',
      scopeId: project.id,
      fieldPath: 'commit_style',
      leftVersion: 'small_commits',
      rightVersion: 'squash_final_commit',
      conflictType: 'rule',
    });

    events.push({
      type: 'conflict.detected',
      projectId: project.id,
      scopeType: 'project',
      scopeId: project.id,
      actor: 'system-import',
      payload: conflict,
    });
  }

  if (events.length > 0) {
    await appendEvents(project.id, events);
  }
  await rebuildProjectProjection(project.id);
  return importedRules.length;
}

export async function setupProject(rootPath: string): Promise<{
  project: Project;
  importedContextCount: number;
}> {
  const existingProjectId = await getBoundProjectId(rootPath);
  const project = existingProjectId
    ? await readProject(existingProjectId)
    : await createProject({
        title: path.basename(rootPath),
        rootPath,
      });

  if (!project) {
    throw new Error('Unable to resolve or create project during setup.');
  }

  const importedContextCount = await importContextFiles(project);
  const refreshedProject = (await readProject(project.id)) ?? project;

  return {
    project: refreshedProject,
    importedContextCount,
  };
}
