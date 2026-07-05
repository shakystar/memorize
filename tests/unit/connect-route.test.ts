import { describe, expect, it } from 'vitest';

import { resolveConnectRoute } from '../../src/cli/commands/project.js';
import type { BindingMatch } from '../../src/storage/bindings-store.js';

describe('resolveConnectRoute — connect verb dispatch', () => {
  it('routes a fresh/unbound dir to clone', () => {
    expect(resolveConnectRoute(undefined)).toBe('clone');
  });

  it('routes an exact-bound project dir to remote', () => {
    const binding: BindingMatch = {
      projectId: 'proj_x',
      matchedPath: '/repo',
      kind: 'exact',
    };
    expect(resolveConnectRoute(binding)).toBe('remote');
  });

  it('refuses a nested (ancestor) dir with an actionable error', () => {
    const binding: BindingMatch = {
      projectId: 'proj_parent',
      matchedPath: '/repo',
      kind: 'ancestor',
    };
    expect(() => resolveConnectRoute(binding)).toThrow(/nested inside project proj_parent/);
  });
});
