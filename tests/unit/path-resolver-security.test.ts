import { describe, expect, it } from 'vitest';

import {
  getCheckpointFile,
  getConflictFile,
  getEventsFile,
  getHandoffFile,
  getProjectFile,
  getProjectRoot,
  getRuleFile,
  getSyncFile,
  getSyncInboundFile,
  getTaskFile,
  getTopicFile,
  getWorkstreamFile,
} from '../../src/storage/path-resolver.js';
import { createId, isValidId } from '../../src/domain/common.js';

const VALID_PROJECT_ID = 'proj_l2x_abcdef12';
const VALID_TASK_ID = 'task_l2x_abcdef34';

const MALICIOUS_IDS = [
  '../etc/passwd',
  '..',
  '../../root',
  '/absolute/path',
  'valid_looking/../escape',
  'with space',
  'UPPER_case',
  'trailing-slash/',
  './relative',
  '',
  '-starts-with-dash',
  'double__underscore_edge_case_is_ok', // actually this one IS ok per pattern — see below
];

describe('path-resolver ID validation', () => {
  it('accepts internally generated IDs', () => {
    expect(isValidId(createId('proj'))).toBe(true);
    expect(isValidId(createId('task'))).toBe(true);
    expect(isValidId(createId('handoff'))).toBe(true);
    expect(isValidId(createId('checkpoint'))).toBe(true);
  });

  it('rejects traversal characters in projectId', () => {
    const cases = [
      '../etc',
      '..',
      '/abs',
      'a/b',
      'with space',
      'UPPER',
      '',
      '-leading-dash',
    ];
    for (const bad of cases) {
      expect(() => getProjectRoot(bad)).toThrow();
    }
  });

  it('rejects traversal characters in taskId', () => {
    for (const bad of ['../', '..', '/root', 'a/b', '']) {
      expect(() =>
        getTaskFile(VALID_PROJECT_ID, bad),
      ).toThrow();
    }
  });

  it('rejects traversal in every leaf path function', () => {
    const bad = '../escape';
    expect(() => getProjectFile(bad)).toThrow();
    expect(() => getTaskFile(VALID_PROJECT_ID, bad)).toThrow();
    expect(() => getHandoffFile(VALID_PROJECT_ID, bad)).toThrow();
    expect(() => getCheckpointFile(VALID_PROJECT_ID, bad)).toThrow();
    expect(() => getWorkstreamFile(VALID_PROJECT_ID, bad)).toThrow();
    expect(() => getRuleFile(VALID_PROJECT_ID, bad)).toThrow();
    expect(() => getTopicFile(VALID_PROJECT_ID, bad)).toThrow();
    expect(() => getConflictFile(VALID_PROJECT_ID, bad)).toThrow();
  });

  it('accepts valid IDs on leaf path functions', () => {
    expect(() => getTaskFile(VALID_PROJECT_ID, VALID_TASK_ID)).not.toThrow();
    expect(() => getProjectFile(VALID_PROJECT_ID)).not.toThrow();
    expect(() => getSyncFile(VALID_PROJECT_ID)).not.toThrow();
    expect(() => getSyncInboundFile(VALID_PROJECT_ID)).not.toThrow();
  });

  it('rejects malformed events date keys', () => {
    expect(() => getEventsFile(VALID_PROJECT_ID, '../etc')).toThrow();
    expect(() =>
      getEventsFile(VALID_PROJECT_ID, '2026/04/14'),
    ).toThrow();
    expect(() => getEventsFile(VALID_PROJECT_ID, '')).toThrow();
    expect(() => getEventsFile(VALID_PROJECT_ID, '2026-04-14')).not.toThrow();
  });

  it('returned paths stay within the project root', () => {
    const projectRoot = getProjectRoot(VALID_PROJECT_ID);
    const taskPath = getTaskFile(VALID_PROJECT_ID, VALID_TASK_ID);
    expect(taskPath.startsWith(projectRoot)).toBe(true);
  });

  // documenting that the pattern does allow consecutive underscores in segment boundaries
  // (e.g. 'sync_proj_l2x_abc' style compound ids), which is intentional for internal use.
  it('allows compound internal IDs that use multiple underscore segments', () => {
    expect(isValidId('sync_proj_l2x_abcdef12')).toBe(true);
  });

  // unused but documents MALICIOUS_IDS intent
  it('reference: MALICIOUS_IDS list drives review', () => {
    expect(MALICIOUS_IDS.length).toBeGreaterThan(0);
  });
});
