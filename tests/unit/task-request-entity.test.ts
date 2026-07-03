import { describe, expect, it } from 'vitest';

import { createTaskRequest } from '../../src/domain/entities.js';

describe('createTaskRequest', () => {
  it('mints a pending request with honest empty defaults', () => {
    const request = createTaskRequest({
      projectId: 'proj_requester',
      targetProjectId: 'proj_target',
      title: 'Fix the flaky sync test',
    });
    expect(request.id).toMatch(/^taskreq_/);
    expect(request.status).toBe('pending');
    expect(request.projectId).toBe('proj_requester');
    expect(request.targetProjectId).toBe('proj_target');
    // No title fallback: absent description/goal stay '' (same rule as Task).
    expect(request.description).toBe('');
    expect(request.goal).toBe('');
    expect(request.acceptanceCriteria).toEqual([]);
    expect(request.resolvedByTaskId).toBeUndefined();
  });

  it('carries provided optional fields through', () => {
    const request = createTaskRequest({
      projectId: 'proj_requester',
      targetProjectId: 'proj_target',
      title: 'T',
      description: 'D',
      goal: 'G',
      acceptanceCriteria: ['a', 'b'],
    });
    expect(request.description).toBe('D');
    expect(request.goal).toBe('G');
    expect(request.acceptanceCriteria).toEqual(['a', 'b']);
  });
});
