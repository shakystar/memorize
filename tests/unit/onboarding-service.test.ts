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
  installOpencode: string[];
}

function presence(present: boolean): AgentDetectionResult['claude'] {
  return present ? { present: true, via: 'config-dir' } : { present: false, via: null };
}

function fakeDeps(
  agents: { claude: boolean; codex: boolean; opencode: boolean },
  overrides: Partial<OnboardDeps> = {},
): { deps: OnboardDeps; calls: Calls } {
  const calls: Calls = {
    setup: [],
    installClaude: [],
    installCodex: [],
    installOpencode: [],
  };
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
      opencode: presence(agents.opencode),
    }),
    installers: {
      claude: async (cwd) => {
        calls.installClaude.push(cwd);
        return `${cwd}/.claude/settings.local.json`;
      },
      codex: async (cwd) => {
        calls.installCodex.push(cwd);
        return '/home/user/.codex/hooks.json';
      },
      opencode: async (cwd) => {
        calls.installOpencode.push(cwd);
        return '/home/user/.config/opencode/opencode.json';
      },
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('onboardProject', () => {
  it('wires nothing when no harness is present, but still binds + imports', async () => {
    const { deps, calls } = fakeDeps({ claude: false, codex: false, opencode: false });
    const result = await onboardProject('/repo', {}, deps);

    expect(calls.setup).toHaveLength(1);
    expect(calls.installClaude).toHaveLength(0);
    expect(calls.installCodex).toHaveLength(0);
    expect(calls.installOpencode).toHaveLength(0);
    expect(result.wired).toEqual([]);
    expect(result.importedContextCount).toBe(2);
  });

  it('wires only claude when only claude is present', async () => {
    const { deps, calls } = fakeDeps({ claude: true, codex: false, opencode: false });
    const result = await onboardProject('/repo', {}, deps);

    expect(calls.installClaude).toEqual(['/repo']);
    expect(calls.installCodex).toHaveLength(0);
    expect(result.wired).toEqual([
      {
        id: 'claude',
        label: 'Claude Code',
        configPath: '/repo/.claude/settings.local.json',
      },
    ]);
  });

  it('wires only opencode when only opencode is present', async () => {
    const { deps, calls } = fakeDeps({ claude: false, codex: false, opencode: true });
    const result = await onboardProject('/repo', {}, deps);

    expect(calls.installOpencode).toEqual(['/repo']);
    expect(result.wired).toEqual([
      {
        id: 'opencode',
        label: 'opencode',
        configPath: '/home/user/.config/opencode/opencode.json',
      },
    ]);
  });

  it('wires all present harnesses in registry order', async () => {
    const { deps } = fakeDeps({ claude: true, codex: true, opencode: true });
    const result = await onboardProject('/repo', {}, deps);

    expect(result.wired.map((w) => w.id)).toEqual(['claude', 'codex', 'opencode']);
  });

  it('detects a harness but does not wire it when no installer is registered', async () => {
    const { deps, calls } = fakeDeps(
      { claude: false, codex: false, opencode: true },
      { installers: {} },
    );
    const result = await onboardProject('/repo', {}, deps);

    expect(calls.installOpencode).toHaveLength(0);
    expect(result.wired).toEqual([]);
    expect(result.agents.opencode.present).toBe(true);
  });

  it('threads --nested through to setupProject', async () => {
    const { deps, calls } = fakeDeps({ claude: false, codex: false, opencode: false });
    const result = await onboardProject('/repo', { nested: true }, deps);

    expect(calls.setup[0]?.allowNested).toBe(true);
    expect(result.nested).toBe(true);
  });

  it('defaults allowNested to false', async () => {
    const { deps, calls } = fakeDeps({ claude: false, codex: false, opencode: false });
    await onboardProject('/repo', {}, deps);
    expect(calls.setup[0]?.allowNested).toBe(false);
  });
});
