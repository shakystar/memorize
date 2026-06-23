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
  listProjects,
  readProject,
  relocateProject,
} from './project-service.js';
import { computeRepoIdentity, type RepoIdentity } from './repo-identity.js';

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

/**
 * Has the project's stored rootPath disappeared from disk? A real move leaves
 * the old location gone; a sibling checkout / monorepo peer is still present
 * (so it is NOT a relocation candidate). ENOENT = gone; any other stat error is
 * propagated rather than mistaken for "gone" (never orphan on a transient EACCES).
 */
async function rootPathGone(rootPath: string): Promise<boolean> {
  try {
    await fs.stat(rootPath);
    return false;
  } catch (error) {
    // ENOENT: the path itself is gone. ENOTDIR: an intermediate component is now
    // a file (the old tree was deleted and something took its place) — the repo
    // is just as gone, and throwing here would crash setup entirely.
    if (isEnoent(error)) return true;
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOTDIR') return true;
    throw error;
  }
}

interface RelocationDecision {
  /** Confident single move → reuse the project at the new path. */
  autoProjectId?: string;
  /** Ambiguous/legacy candidates → warn-and-create, never auto. */
  warnCandidates: Project[];
}

/**
 * Decide whether the repo at `rootPath` is a MOVED existing project (#145).
 *
 * Strongest → weakest: stable git identity (origin URL, then root commit) whose
 * old path is gone on disk = a move. Auto-relocate only on a confident single
 * match (the safe, non-interactive rule — hooks call setup non-interactively);
 * anything ambiguous, or a legacy project with no captured identity, surfaces
 * as a warning so the user can `project relocate` rather than silently orphan.
 */
async function decideRelocation(
  rootPath: string,
  identity: RepoIdentity,
): Promise<RelocationDecision> {
  const projects = await listProjects();
  const targetBase = path.basename(rootPath);

  if (identity.originUrl || identity.rootCommit) {
    // Match on the strongest evidence available. When BOTH signals exist on both
    // sides, require both to agree: a GitHub fork shares the upstream's root
    // commit but has a different origin URL, so a rootCommit-only OR would
    // wrongly fold a fork into the upstream project — itself a data-safety
    // incident. Fall back to single-field matching only when one side lacks it.
    const byIdentity = projects.filter((p) => {
      const bothHaveOrigin = identity.originUrl != null && p.originUrl != null;
      const bothHaveCommit = identity.rootCommit != null && p.rootCommit != null;
      if (bothHaveOrigin && bothHaveCommit) {
        return (
          p.originUrl === identity.originUrl &&
          p.rootCommit === identity.rootCommit
        );
      }
      if (bothHaveOrigin) return p.originUrl === identity.originUrl;
      if (bothHaveCommit) return p.rootCommit === identity.rootCommit;
      return false;
    });

    const moved: Project[] = [];
    for (const candidate of byIdentity) {
      if (await rootPathGone(candidate.rootPath)) moved.push(candidate);
    }

    if (moved.length > 0) {
      // Prefer an unambiguous basename match (disambiguates a wholesale
      // monorepo move where several peers share origin + root commit).
      const sameBase = moved.filter(
        (p) => path.basename(p.rootPath) === targetBase,
      );
      const confident = sameBase.length === 1 ? sameBase[0] : moved.length === 1 ? moved[0] : undefined;
      if (confident) return { autoProjectId: confident.id, warnCandidates: [] };
      return { warnCandidates: moved }; // ambiguous — warn, never auto
    }
  }

  // Legacy fallback: projects predating identity capture can only be matched by
  // the orphaned-path + basename heuristic, and only ever warned about.
  const legacy: Project[] = [];
  for (const candidate of projects) {
    if (candidate.originUrl || candidate.rootCommit) continue;
    if (path.basename(candidate.rootPath) !== targetBase) continue;
    if (await rootPathGone(candidate.rootPath)) legacy.push(candidate);
  }
  return { warnCandidates: legacy };
}

function buildRelocationWarning(
  candidates: Project[],
  rootPath: string,
): string {
  const lines = candidates.map(
    (p) => `  - ${p.title} (${p.id}) last seen at ${p.rootPath}`,
  );
  const only = candidates.length === 1 ? candidates[0] : undefined;
  const relocateCmd = only
    ? `memorize project relocate "${rootPath}" --project ${only.id}`
    : `memorize project relocate "${rootPath}" --project <id>`;
  return (
    `A new project was created at ${rootPath}, but it may be a MOVED existing ` +
    `project whose old path is gone. If so, your earlier memory is under one of ` +
    `these instead:\n${lines.join('\n')}\n` +
    `To adopt it (retaining that memory) run:\n  ${relocateCmd}`
  );
}

export async function setupProject(rootPath: string): Promise<{
  project: Project;
  importedContextCount: number;
  relocated: boolean;
  warnings: string[];
}> {
  const warnings: string[] = [];
  let relocated = false;
  let project: Project | undefined;

  const existingProjectId = await getBoundProjectId(rootPath);
  if (existingProjectId) {
    project = await readProject(existingProjectId);
  } else {
    // No binding at this path — detect a moved repo BEFORE creating, so we never
    // silently orphan the original's memory (#145).
    const identity = computeRepoIdentity(rootPath);
    const decision = await decideRelocation(rootPath, identity);
    if (decision.autoProjectId) {
      const result = await relocateProject({
        newPath: rootPath,
        projectId: decision.autoProjectId,
      });
      project = result.project;
      relocated = true;
    } else {
      project = await createProject({
        title: path.basename(rootPath),
        rootPath,
        ...(identity.originUrl ? { originUrl: identity.originUrl } : {}),
        ...(identity.rootCommit ? { rootCommit: identity.rootCommit } : {}),
      });
      if (decision.warnCandidates.length > 0) {
        warnings.push(buildRelocationWarning(decision.warnCandidates, rootPath));
      }
    }
  }

  if (!project) {
    throw new Error('Unable to resolve or create project during setup.');
  }

  const importedContextCount = await importContextFiles(project);
  const refreshedProject = (await readProject(project.id)) ?? project;

  return {
    project: refreshedProject,
    importedContextCount,
    relocated,
    warnings,
  };
}
