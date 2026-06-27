import type { Project } from '../domain/entities.js';
import {
  defaultDetectDeps,
  detectAgents,
  type AgentDetectionResult,
} from './agent-detect.js';
import {
  installClaudeIntegration,
  installCodexIntegration,
} from './install-service.js';
import { setupProject } from './setup-service.js';

/**
 * One-shot project onboarding (`memorize init`): bind/adopt the cwd + import
 * context, then wire whichever agent(s) are present on this machine. Composes
 * the existing idempotent primitives (setupProject + detectAgents + the two
 * install integrations) so the four historical steps collapse into one, with
 * no behavior change to any of them. Mirrors the deps-injection shape of
 * `runRefresh` (update-service) so the orchestration is unit-testable without
 * touching the real machine or spawning a CLI.
 */
export interface OnboardingResult {
  project: Project;
  importedContextCount: number;
  /** setupProject auto-relocated a moved repo into this path. */
  relocated: boolean;
  /** A SEPARATE nested project was created inside an existing one (--nested). */
  nested: boolean;
  /** Relocation-candidate warnings surfaced by setupProject. */
  warnings: string[];
  agents: AgentDetectionResult;
  wiredClaude: boolean;
  wiredCodex: boolean;
  /** Path written by installClaudeIntegration (when wiredClaude). */
  claudeSettingsPath?: string;
  /** Path written by installCodexIntegration (when wiredCodex). */
  codexHooksPath?: string;
}

export interface OnboardDeps {
  setupProject: typeof setupProject;
  detectAgents: () => AgentDetectionResult;
  installClaude: (cwd: string) => Promise<string>;
  installCodex: (cwd: string) => Promise<string>;
}

export function defaultOnboardDeps(): OnboardDeps {
  return {
    setupProject,
    detectAgents: () => detectAgents(defaultDetectDeps()),
    installClaude: installClaudeIntegration,
    // The integration variant (not bare installCodexHooks) — it also plants
    // THIS project's AGENTS.md ground-rule block, matching `install codex`.
    installCodex: installCodexIntegration,
  };
}

export async function onboardProject(
  cwd: string,
  opts: { nested?: boolean } = {},
  deps: OnboardDeps = defaultOnboardDeps(),
): Promise<OnboardingResult> {
  const setup = await deps.setupProject(cwd, {
    allowNested: opts.nested === true,
  });

  const agents = deps.detectAgents();

  let wiredClaude = false;
  let wiredCodex = false;
  let claudeSettingsPath: string | undefined;
  let codexHooksPath: string | undefined;

  if (agents.claude.present) {
    claudeSettingsPath = await deps.installClaude(cwd);
    wiredClaude = true;
  }
  if (agents.codex.present) {
    codexHooksPath = await deps.installCodex(cwd);
    wiredCodex = true;
  }

  return {
    project: setup.project,
    importedContextCount: setup.importedContextCount,
    relocated: setup.relocated,
    nested: setup.nested,
    warnings: setup.warnings,
    agents,
    wiredClaude,
    wiredCodex,
    ...(claudeSettingsPath ? { claudeSettingsPath } : {}),
    ...(codexHooksPath ? { codexHooksPath } : {}),
  };
}
