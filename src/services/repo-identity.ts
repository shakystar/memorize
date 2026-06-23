import { spawnSync } from 'node:child_process';

/**
 * Stable identity of a git repository that survives a path move (#145).
 *
 * Used by `project setup` to detect a moved/adopted repo at a new path and
 * relocate the existing project instead of silently minting an empty one that
 * orphans the original's memory. Both fields are optional: a plain (non-git)
 * directory yields neither, and detection then falls back to the path/basename
 * heuristic. Identity captured here is persisted on the project at create time.
 */
export interface RepoIdentity {
  /** Normalized `origin` remote URL — strongest signal, unique per repo. */
  originUrl?: string;
  /** First (oldest) root commit sha — survives moves and remote renames. */
  rootCommit?: string;
}

/**
 * Normalize a git remote URL so the same repo compares equal across the common
 * representations (scp-style vs https vs ssh, embedded credentials, a trailing
 * `.git` or slash). The result is a comparison key, not a clonable URL.
 *
 * Examples (all → `github.com/acme/widgets`):
 *   - https://user:token@github.com/acme/widgets.git/
 *   - git@github.com:acme/widgets.git
 *   - ssh://git@github.com/acme/widgets
 *
 * Known limitation: scp-style with an explicit port (`git@host:2222/repo`) is
 * rare/ambiguous and normalizes differently from its `ssh://host:2222/` form.
 */
export function normalizeOriginUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return '';

  // scp-style (`git@host:path`) has no scheme — rewrite to a URL shape so the
  // host/path split below treats it like every other form.
  if (!url.includes('://')) {
    const scp = url.match(/^([^@/]+)@([^:/]+):(.+)$/);
    if (scp) {
      url = `ssh://${scp[1]}@${scp[2]}/${scp[3]}`;
    }
  }

  url = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // drop scheme
  url = url.replace(/^[^@/]+@/, ''); // drop user[:password]@
  url = url.replace(/\/+$/, ''); // drop trailing slashes
  url = url.replace(/\.git$/i, ''); // drop trailing .git
  return url;
}

function git(rootPath: string, args: string[]): string | undefined {
  const result = spawnSync('git', args, {
    cwd: rootPath,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return undefined;
  const out = result.stdout?.trim();
  return out ? out : undefined;
}

/**
 * Compute the repo identity for `rootPath`. Returns an empty object when the
 * path is not inside a git work tree (or git is unavailable) — callers treat
 * that as "no signal" and never auto-relocate on it.
 */
export function computeRepoIdentity(rootPath: string): RepoIdentity {
  if (git(rootPath, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return {};
  }

  const identity: RepoIdentity = {};

  const origin = git(rootPath, ['remote', 'get-url', 'origin']);
  if (origin) {
    const normalized = normalizeOriginUrl(origin);
    if (normalized) identity.originUrl = normalized;
  }

  // A repo can have multiple root commits (merged histories). `rev-list
  // --max-parents=0` prints them in reverse-chronological (committer date)
  // order, so the LAST line is the oldest root — the most stable anchor across
  // later history edits.
  const roots = git(rootPath, ['rev-list', '--max-parents=0', 'HEAD']);
  if (roots) {
    const lines = roots.split('\n').filter(Boolean);
    const oldest = lines[lines.length - 1];
    if (oldest) identity.rootCommit = oldest;
  }

  return identity;
}
