import fs from 'node:fs/promises';
import path from 'node:path';

import type { Project, Rule } from '../domain/entities.js';
import { createConflict, createRule } from '../domain/entities.js';
import { isEnoent } from '../storage/fs-utils.js';
import { appendEvent } from '../storage/event-store.js';
import { rebuildProjectProjection } from './projection-store.js';
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

async function importContextFiles(project: Project): Promise<number> {
  const files = await discoverContextFiles(project.rootPath);
  const importedRules: Rule[] = [];

  for (const file of files) {
    const rule: Rule = createRule({
      scopeType: 'project',
      scopeId: project.id,
      title: file.title,
      body: file.body,
      updatedBy: 'system-import',
      source: 'imported',
    });

    await appendEvent({
      type: 'rule.upserted',
      projectId: project.id,
      scopeType: 'project',
      scopeId: project.id,
      actor: 'system-import',
      payload: rule,
    });
    importedRules.push(rule);
  }

  if (files.length > 0) {
    await appendEvent({
      type: 'project.updated',
      projectId: project.id,
      scopeType: 'project',
      scopeId: project.id,
      actor: 'system-import',
      payload: {
        importedContextCount: files.length,
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

    await appendEvent({
      type: 'conflict.detected',
      projectId: project.id,
      scopeType: 'project',
      scopeId: project.id,
      actor: 'system-import',
      payload: conflict,
    });
  }

  await rebuildProjectProjection(project.id);
  return files.length;
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
