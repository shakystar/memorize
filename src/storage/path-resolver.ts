import os from 'node:os';
import path from 'node:path';

import { assertValidId } from '../domain/common.js';
import { resolveActiveAccount } from '../domain/identity/account.js';
import {
  accountOfPersonalStore,
  isPersonalStoreId,
} from '../domain/identity/personal-store.js';

export function getMemorizeRoot(): string {
  return process.env.MEMORIZE_ROOT ?? path.join(os.homedir(), '.memorize');
}

/**
 * Root of the per-account store tree. Account-scoped stores (personal + projects)
 * isolate under `accounts/<accountId>/` so multiple accounts coexist on one host
 * without clobber (memorize SoT-020). Host-level state (credentials, profile/,
 * update-check) stays at the memorize root, NOT under an account.
 */
export function getAccountsRoot(): string {
  return path.join(getMemorizeRoot(), 'accounts');
}

export function getAccountRoot(accountId: string): string {
  assertValidId(accountId, 'accountId');
  const accountsRoot = getAccountsRoot();
  return ensureWithinRoot(path.join(accountsRoot, accountId), accountsRoot);
}

export function getProjectsRoot(
  accountId: string = resolveActiveAccount(),
): string {
  return path.join(getAccountRoot(accountId), 'projects');
}

/**
 * Home of an account's personal memory store — a SIBLING of that account's
 * `projects/` under `accounts/<accountId>/`, deliberately NOT under `projects/`,
 * so the personal store never appears in `listProjects()` (which reads the
 * account's `projects/`) and stays out of every project enumeration sweep. One
 * personal store per account (memorize SoT-010/020). Defaults to the active account.
 */
export function getPersonalRoot(
  accountId: string = resolveActiveAccount(),
): string {
  return path.join(getAccountRoot(accountId), 'personal');
}

function ensureWithinRoot(candidate: string, root: string): string {
  const candidateAbs = path.resolve(candidate);
  const rootAbs = path.resolve(root);
  if (
    candidateAbs !== rootAbs &&
    !candidateAbs.startsWith(rootAbs + path.sep)
  ) {
    throw new Error(
      `Path escapes expected root: ${candidateAbs} is outside ${rootAbs}`,
    );
  }
  return candidateAbs;
}

export function getProjectRoot(projectId: string): string {
  assertValidId(projectId, 'projectId');
  // A personal store routes to its OWNING account's personal dir — the account is
  // derived from the store id itself (accountOfPersonalStore), not from ambient
  // state. Every derived path (db file, sync, topics, locks) flows through here,
  // so this single redirect isolates the whole store with no other change.
  if (isPersonalStoreId(projectId)) {
    return getPersonalRoot(accountOfPersonalStore(projectId));
  }
  // A plain project belongs to the ACTIVE account (M1 is single-account; a
  // project→account binding for multi-account resolution is a W1 concern).
  const projectsRoot = getProjectsRoot();
  return ensureWithinRoot(path.join(projectsRoot, projectId), projectsRoot);
}

export function getProjectDbFile(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(path.join(projectRoot, 'memorize.db'), projectRoot);
}

export function getProjectBindingsFile(): string {
  return path.join(getMemorizeRoot(), 'profile', 'bindings.json');
}

/**
 * Host-scoped sync credential store (#192), the git-credential analog: a single
 * `0600` JSON file keyed by normalized Hub host so `auth login` is run once per
 * host and later clone/sync carry no inline `--token`. Top-level (next to
 * `projects/` and `profile/`), like git's `~/.git-credentials`.
 */
export function getCredentialsFile(): string {
  return path.join(getMemorizeRoot(), 'credentials');
}

export function getTopicsDir(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(path.join(projectRoot, 'topics'), projectRoot);
}

export function getTopicFile(projectId: string, topicId: string): string {
  assertValidId(topicId, 'topicId');
  const topicsDir = getTopicsDir(projectId);
  return ensureWithinRoot(path.join(topicsDir, `${topicId}.md`), topicsDir);
}

export function getSyncFile(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(
    path.join(projectRoot, 'sync', 'remote.json'),
    projectRoot,
  );
}

