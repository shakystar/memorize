import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { type HarnessId, harnessIds } from '../harness/registry.js';

/** @deprecated alias of {@link HarnessId} — kept for existing call sites. */
export type AgentName = HarnessId;

export interface AgentPresence {
  present: boolean;
  via: 'config-dir' | 'path' | null;
}

/**
 * Presence keyed by harness id. `Record<HarnessId, …>` is structurally the
 * old `{ claude; codex }` shape, so `result.claude` / `result.codex` access
 * (and object-literal construction in tests) keeps compiling unchanged.
 */
export type AgentDetectionResult = Record<HarnessId, AgentPresence>;

/**
 * Injectable inputs so detection is unit-testable without touching the
 * real machine. `defaultDetectDeps()` wires the real environment.
 */
export interface DetectDeps {
  pathValue: string;
  homedir: string;
  exists: (candidate: string) => boolean;
  pathDelimiter: string;
  isWindows: boolean;
}

function detectAgent(name: HarnessId, deps: DetectDeps): AgentPresence {
  // Config dir is the strongest signal that the agent has actually run.
  const configDir = path.join(deps.homedir, `.${name}`);
  if (deps.exists(configDir)) return { present: true, via: 'config-dir' };

  // Otherwise look for the launcher on PATH. Windows resolves binaries
  // through extensions, so probe the common shim/exe forms there.
  const exts = deps.isWindows ? ['.cmd', '.exe', ''] : [''];
  for (const dir of deps.pathValue.split(deps.pathDelimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (deps.exists(path.join(dir, `${name}${ext}`))) {
        return { present: true, via: 'path' };
      }
    }
  }
  return { present: false, via: null };
}

export function detectAgents(deps: DetectDeps): AgentDetectionResult {
  return Object.fromEntries(
    harnessIds.map((id) => [id, detectAgent(id, deps)]),
  ) as AgentDetectionResult;
}

export function defaultDetectDeps(): DetectDeps {
  return {
    // MEMORIZE_DETECT_PATH is a test-only override so integration tests can
    // disable PATH-based detection (and rely solely on a sandboxed HOME)
    // without blanking the real PATH that spawns node. Falls back to PATH.
    pathValue: process.env.MEMORIZE_DETECT_PATH ?? process.env.PATH ?? '',
    homedir: os.homedir(),
    exists: existsSync,
    pathDelimiter: path.delimiter,
    isWindows: process.platform === 'win32',
  };
}
