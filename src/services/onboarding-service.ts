import type { Project } from '../domain/entities.js';
import { type HarnessId, harnessRegistry } from '../harness/registry.js';
import {
  defaultDetectDeps,
  detectAgents,
  type AgentDetectionResult,
} from './agent-detect.js';
import {
  installClaudeIntegration,
  installCodexIntegration,
  installOpencodeIntegration,
} from './install-service.js';
import { setupProject } from './setup-service.js';

/**
 * One-shot project onboarding (`memorize init`): bind/adopt the cwd + import
 * context, then wire whichever harness(es) are present on this machine. Composes
 * the existing idempotent primitives (setupProject + detectAgents + the per-
 * harness install integrations) so the historical multi-step flow collapses into
 * one. Registry-driven: each present harness with a registered installer is
 * wired, so adding a harness needs no change here. Mirrors the deps-injection
 * shape of `runRefresh` (update-service) so it is unit-testable without touching
 * the real machine or spawning a CLI.
 */
export interface WiredHarness {
  id: HarnessId;
  /** Display label from the registry descriptor. */
  label: string;
  /** Primary config path the installer wrote (for the install summary). */
  configPath: string;
}

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
  /** Harnesses detected-present AND wired, in registry order. */
  wired: WiredHarness[];
}

export type HarnessInstaller = (cwd: string) => Promise<string>;

export interface OnboardDeps {
  setupProject: typeof setupProject;
  detectAgents: () => AgentDetectionResult;
  /** Installer per harness id; onboarding calls the one matching each present
   *  harness. A harness with no installer here is detected but not wired. */
  installers: Partial<Record<HarnessId, HarnessInstaller>>;
}

export function defaultOnboardDeps(): OnboardDeps {
  return {
    setupProject,
    detectAgents: () => detectAgents(defaultDetectDeps()),
    installers: {
      claude: installClaudeIntegration,
      // The integration variants (not bare hook installers) — they also plant
      // THIS project's AGENTS.md/CLAUDE.md ground-rule block.
      codex: installCodexIntegration,
      opencode: installOpencodeIntegration,
    },
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

  const wired: WiredHarness[] = [];
  for (const descriptor of harnessRegistry) {
    if (!agents[descriptor.id]?.present) continue;
    const installer = deps.installers[descriptor.id];
    if (!installer) continue;
    const configPath = await installer(cwd);
    wired.push({ id: descriptor.id, label: descriptor.label, configPath });
  }

  return {
    project: setup.project,
    importedContextCount: setup.importedContextCount,
    relocated: setup.relocated,
    nested: setup.nested,
    warnings: setup.warnings,
    agents,
    wired,
  };
}
