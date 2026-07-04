import { describe, expect, it } from 'vitest';

import { formatHitLine } from '../../src/cli/commands/search.js';
import type { SearchHit } from '../../src/services/search-service.js';

const selfHit: SearchHit = {
  entityId: 'task_1',
  kind: 'task',
  score: -1,
  snippet: 'do the thing',
};

describe('formatHitLine', () => {
  it('renders a self hit with no provenance tag (unchanged format)', () => {
    expect(formatHitLine(selfHit)).toBe('task\ttask_1\tdo the thing');
  });

  it('prefixes a foreign hit with its writer id', () => {
    const foreign: SearchHit = { ...selfHit, sourceProjectId: 'proj_bob' };
    expect(formatHitLine(foreign)).toBe('[proj_bob] task\ttask_1\tdo the thing');
  });
});
