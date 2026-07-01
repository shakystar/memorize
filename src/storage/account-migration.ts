import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_ACCOUNT_ID } from '../domain/identity/account.js';
import { getAccountsRoot, getMemorizeRoot } from './path-resolver.js';

/**
 * One-time, idempotent, lossless migration from the pre-account on-disk layout
 * (`<root>/projects/`, `<root>/personal/`) to the account-scoped layout
 * (`<root>/accounts/<DEFAULT_ACCOUNT_ID>/{projects,personal}/`) introduced in M1.
 *
 * Runs before any store access (CLI startup, see cli/index.ts). Each legacy
 * directory is moved only if it exists AND its account-scoped target does not yet
 * exist, so the migration is safe to re-run and safe after a partial move (the two
 * directories are handled independently). `renameSync` is atomic within a single
 * volume, and `~/.memorize` is one tree, so no bytes are copied or duplicated.
 * Host-level state (`credentials`, `profile/bindings.json`, `update-check.json`)
 * is NOT account-scoped and stays at the root untouched — `bindings.json` maps
 * cwd→projectId (path-independent), so the move needs no binding rewrite.
 */
export function migrateToAccountLayout(): void {
  const root = getMemorizeRoot();
  const defaultAccountRoot = path.join(getAccountsRoot(), DEFAULT_ACCOUNT_ID);

  for (const name of ['projects', 'personal'] as const) {
    const legacy = path.join(root, name);
    const target = path.join(defaultAccountRoot, name);
    if (existsSync(legacy) && !existsSync(target)) {
      mkdirSync(defaultAccountRoot, { recursive: true });
      renameSync(legacy, target);
    }
  }
}
