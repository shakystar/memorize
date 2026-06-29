import { describe, expect, it } from 'vitest';

import { createProject } from '../../src/domain/entities.js';
import { type HarnessId, harnessIds } from '../../src/harness/registry.js';
import type { AgentDetectionResult } from '../../src/services/agent-detect.js';
import {
  onboardProject,
  type OnboardDeps,
} from '../../src/services/onboarding-service.js';

function presence(present: boolean): AgentDetectionResult['claude'] {
  return present ? { present: true, via: 'config-dir' } : { present: false, via: null };
}

interface Calls {
  setup: Array<{ cwd: string; allowNested: boolean | undefined }>;
  installed: HarnessId[];
}

/**
 * Registry-driven fakes: detection + installers are built from `harnessIds`, so
 * adding a harness to the registry needs NO change here. `present` lists which
 * harnesses report present (others default to absent).
 */
function fakeDeps(
  present: Partial<Record<HarnessId, boolean>>,
  overrides: Partial<OnboardDeps> = {},
): { deps: OnboardDeps; calls: Calls } {
  const calls: Calls = { setup: [], installed: [] };
  const installers = Object.fromEntries(
    harnessIds.map((id) => [
      id,
      async (cwd: string) => {
        calls.installed.push(id);
        return `${cwd}/.${id}/config`;
      },
    ]),
  ) as OnboardDeps['installers'];
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
    detectAgents: (): AgentDetectionResult =>
      Object.fromEntries(
        harnessIds.map((id) => [id, presence(present[id] ?? false)]),
      ) as AgentDetectionResult,
    installers,
    ...overrides,
  };
  return { deps, calls };
}

describe('onboardProject', () => {
  it('wires nothing when no harness is present, but still binds + imports', async () => {
    const { deps, calls } = fakeDeps({});
    const result = await onboardProject('/repo', {}, deps);

    expect(calls.setup).toHaveLength(1);
    expect(calls.installed).toEqual([]);
    expect(result.wired).toEqual([]);
    expect(result.importedContextCount).toBe(2);
  });

  it('wires only the present harness, with its config path', async () => {
    const { deps, calls } = fakeDeps({ claude: true });
    const result = await onboardProject('/repo', {}, deps);

    expect(calls.installed).toEqual(['claude']);
    expect(result.wired.map((w) => w.id)).toEqual(['claude']);
    expect(result.wired[0]?.configPath).toBe('/repo/.claude/config');
  });

  it('wires all present harnesses in registry order', async () => {
    const present = Object.fromEntries(harnessIds.map((id) => [id, true]));
    const { deps } = fakeDeps(present);
    const result = await onboardProject('/repo', {}, deps);

    expect(result.wired.map((w) => w.id)).toEqual([...harnessIds]);
  });

  it('detects a harness but does not wire it when no installer is registered', async () => {
    const { deps, calls } = fakeDeps({ gemini: true }, { installers: {} });
    const result = await onboardProject('/repo', {}, deps);

    expect(calls.installed).toEqual([]);
    expect(result.wired).toEqual([]);
    expect(result.agents.gemini.present).toBe(true);
  });

  it('threads --nested through to setupProject', async () => {
    const { deps, calls } = fakeDeps({});
    const result = await onboardProject('/repo', { nested: true }, deps);

    expect(calls.setup[0]?.allowNested).toBe(true);
    expect(result.nested).toBe(true);
  });

  it('defaults allowNested to false', async () => {
    const { deps, calls } = fakeDeps({});
    await onboardProject('/repo', {}, deps);
    expect(calls.setup[0]?.allowNested).toBe(false);
  });
});
