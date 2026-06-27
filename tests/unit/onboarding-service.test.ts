import { describe, expect, it } from 'vitest';

import { createProject } from '../../src/domain/entities.js';
import type { AgentDetectionResult } from '../../src/services/agent-detect.js';
import {
  onboardProject,
  type OnboardDeps,
} from '../../src/services/onboarding-service.js';

interface Calls {
  setup: Array<{ cwd: string; allowNested: boolean | undefined }>;
  installClaude: string[];
  installCodex: string[];
}

function presence(present: boolean): AgentDetectionResult['claude'] {
  return present ? { present: true, via: 'config-dir' } : { present: false, via: null };
}

function fakeDeps(
  agents: { claude: boolean; codex: boolean },
  overrides: Partial<OnboardDeps> = {},
): { deps: OnboardDeps; calls: Calls } {
  const calls: Calls = { setup: [], installClaude: [], installCodex: [] };
  const deps: OnboardDeps = {
    setupProject: async (cwd, opts = {}) => {
      calls.setup.push({ cwd, allowNested: opts.allowNested });
      return {
        project: createProject({ title: 'demo', rootPath: cwd }),
        importedContextCount: 2,
        relocated: false,
        nested: opts.allowNested === true,
        warnings: [],
      };
    },
    detectAgents: (): AgentDetectionResult => ({
      claude: presence(agents.claude),
      codex: presence(agents.codex),
    }),
    installClaude: async (cwd) => {
      calls.installClaude.push(cwd);
      return `${cwd}/.claude/settings.local.json`;
    },
    installCodex: async (cwd) => {
      calls.installCodex.push(cwd);
      return '/home/user/.codex/hooks.json';
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('onboardProject', () => {
  it('wires neither agent when none is present, but still binds + imports', async () => {
    const { deps, calls } = fakeDeps({ claude: false, codex: false });
    const result = await onboardProject('/repo', {}, deps);

    expect(calls.setup).toHaveLength(1);
    expect(calls.installClaude).toHaveLength(0);
    expect(calls.installCodex).toHaveLength(0);
    expect(result.wiredClaude).toBe(false);
    expect(result.wiredCodex).toBe(false);
    expect(result.importedContextCount).toBe(2);
    expect(result.claudeSettingsPath).toBeUndefined();
    expect(result.codexHooksPath).toBeUndefined();
  });

  it('wires only claude when only claude is present', async () => {
    const { deps, calls } = fakeDeps({ claude: true, codex: false });
    const result = await onboardProject('/repo', {}, deps);

    expect(calls.installClaude).toEqual(['/repo']);
    expect(calls.installCodex).toHaveLength(0);
    expect(result.wiredClaude).toBe(true);
    expect(result.wiredCodex).toBe(false);
    expect(result.claudeSettingsPath).toBe('/repo/.claude/settings.local.json');
  });

  it('wires only codex when only codex is present', async () => {
    const { deps, calls } = fakeDeps({ claude: false, codex: true });
    const result = await onboardProject('/repo', {}, deps);

    expect(calls.installClaude).toHaveLength(0);
    expect(calls.installCodex).toEqual(['/repo']);
    expect(result.wiredClaude).toBe(false);
    expect(result.wiredCodex).toBe(true);
    expect(result.codexHooksPath).toBe('/home/user/.codex/hooks.json');
  });

  it('wires both agents when both are present', async () => {
    const { deps, calls } = fakeDeps({ claude: true, codex: true });
    const result = await onboardProject('/repo', {}, deps);

    expect(calls.installClaude).toEqual(['/repo']);
    expect(calls.installCodex).toEqual(['/repo']);
    expect(result.wiredClaude).toBe(true);
    expect(result.wiredCodex).toBe(true);
  });

  it('threads --nested through to setupProject', async () => {
    const { deps, calls } = fakeDeps({ claude: false, codex: false });
    const result = await onboardProject('/repo', { nested: true }, deps);

    expect(calls.setup[0]?.allowNested).toBe(true);
    expect(result.nested).toBe(true);
  });

  it('defaults allowNested to false', async () => {
    const { deps, calls } = fakeDeps({ claude: false, codex: false });
    await onboardProject('/repo', {}, deps);
    expect(calls.setup[0]?.allowNested).toBe(false);
  });
});
