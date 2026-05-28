import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectAgents, type DetectDeps } from '../../src/services/agent-detect.js';

function deps(partial: Partial<DetectDeps>): DetectDeps {
  return {
    pathValue: '',
    homedir: path.join('/home', 'u'),
    exists: () => false,
    pathDelimiter: path.delimiter,
    isWindows: false,
    ...partial,
  };
}

describe('detectAgents', () => {
  it('reports neither present when nothing is found', () => {
    const r = detectAgents(deps({}));
    expect(r.claude).toEqual({ present: false, via: null });
    expect(r.codex).toEqual({ present: false, via: null });
  });

  it('detects codex via its config dir', () => {
    const home = path.join('/home', 'u');
    const codexDir = path.join(home, '.codex');
    const r = detectAgents(deps({ homedir: home, exists: (p) => p === codexDir }));
    expect(r.codex).toEqual({ present: true, via: 'config-dir' });
    expect(r.claude.present).toBe(false);
  });

  it('detects claude via a binary on PATH', () => {
    const bin = path.join('/usr', 'local', 'bin');
    const claudeBin = path.join(bin, 'claude');
    const r = detectAgents(deps({ pathValue: bin, exists: (p) => p === claudeBin }));
    expect(r.claude).toEqual({ present: true, via: 'path' });
  });

  it('prefers config-dir over PATH for the `via` field', () => {
    const home = path.join('/home', 'u');
    const claudeDir = path.join(home, '.claude');
    const r = detectAgents(
      deps({ homedir: home, pathValue: '/anything', exists: (p) => p === claudeDir || p.endsWith('claude') }),
    );
    expect(r.claude.via).toBe('config-dir');
  });

  it('finds a windows .cmd shim on PATH when isWindows', () => {
    const r = detectAgents(
      deps({ isWindows: true, pathValue: 'X', exists: (p) => p.endsWith('claude.cmd') }),
    );
    expect(r.claude.present).toBe(true);
  });

  it('does not look for .cmd shims when not on windows', () => {
    const r = detectAgents(
      deps({ isWindows: false, pathValue: 'X', exists: (p) => p.endsWith('claude.cmd') }),
    );
    expect(r.claude.present).toBe(false);
  });
});
