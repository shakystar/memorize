import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createObservation } from '../../src/domain/entities.js';
import {
  type Consolidator,
  consolidate,
  readLastConsolidateAttempt,
} from '../../src/services/consolidate-service.js';
import { createProject } from '../../src/services/project-service.js';
import { doctor } from '../../src/services/repair-service.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

let sandbox: string;
let memorizeRoot: string;
let projectDir: string;

async function appendObservation(projectId: string): Promise<void> {
  const observation = createObservation({
    projectId,
    signal: 'write-tool',
    sessionId: 'sess_obs_1',
    toolName: 'Write',
    summary: 'Write: /repo/observed.ts',
    filePath: '/repo/observed.ts',
  });
  await appendEvent({
    type: 'observation.captured',
    projectId,
    scopeType: 'session',
    scopeId: 'sess_obs_1',
    actor: 'claude',
    payload: observation,
  });
}

const timingOut: Consolidator = {
  async extract(): Promise<never> {
    throw new Error('claude CLI extractor timed out after 90000ms');
  },
};

const empty: Consolidator = {
  async extract() {
    return [];
  },
};

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-obs51-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  projectDir = join(sandbox, 'project');
  await mkdir(projectDir, { recursive: true });
  process.env.MEMORIZE_ROOT = memorizeRoot;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('consolidation observability (#51): attempt meta + doctor', () => {
  it('after a failed boundary the store answers when/boundary/backend/why/pending', async () => {
    const project = await createProject({ title: 'Obs', rootPath: projectDir });
    await appendObservation(project.id);
    await appendObservation(project.id);

    await expect(
      consolidate({
        projectId: project.id,
        actor: 'claude',
        boundary: 'session-end',
        consolidator: timingOut,
      }),
    ).rejects.toThrow('timed out');

    const attempt = readLastConsolidateAttempt(project.id);
    expect(attempt).toBeDefined();
    expect(Number.isNaN(Date.parse(attempt!.at))).toBe(false); // when
    expect(attempt!.boundary).toBe('session-end'); // which boundary
    expect(attempt!.backend).toBe('custom'); // which backend
    expect(attempt!.outcome).toBe('timeout'); // why
    expect(attempt!.error).toContain('timed out after 90000ms');
    expect(attempt!.pendingObservations).toBe(2); // how many pending
  });

  it('doctor warns when observations are pending and the last attempt failed', async () => {
    const project = await createProject({ title: 'Obs', rootPath: projectDir });
    await appendObservation(project.id);
    await appendObservation(project.id);
    await expect(
      consolidate({
        projectId: project.id,
        actor: 'claude',
        boundary: 'session-end',
        consolidator: timingOut,
      }),
    ).rejects.toThrow();

    const report = await doctor(projectDir);
    const check = report.checks.find((c) => c.id === 'consolidation.health');
    expect(check).toBeDefined();
    expect(check!.status).toBe('warn');
    expect(check!.message).toMatch(/2 observation/);
    expect(check!.message).toMatch(/session-end/);
    expect(check!.message).toMatch(/timeout/);
    expect(check!.fix).toBe('memorize consolidate');
    expect(report.issues.some((issue) => issue.id === 'consolidation.health')).toBe(
      true,
    );
  });

  it('doctor reports ok after a successful boundary ("healthy and idle", not "never ran")', async () => {
    const project = await createProject({ title: 'Obs', rootPath: projectDir });
    await appendObservation(project.id);
    await consolidate({
      projectId: project.id,
      actor: 'claude',
      consolidator: empty,
    });

    const attempt = readLastConsolidateAttempt(project.id);
    expect(attempt!.outcome).toBe('ok');

    const report = await doctor(projectDir);
    const check = report.checks.find((c) => c.id === 'consolidation.health');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toMatch(/ok/);
  });

  it('doctor stays ok for a few pending observations with no recorded attempt', async () => {
    const project = await createProject({ title: 'Obs', rootPath: projectDir });
    await appendObservation(project.id);

    const report = await doctor(projectDir);
    const check = report.checks.find((c) => c.id === 'consolidation.health');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toMatch(/no consolidation attempt recorded/);
  });

  it('doctor warns when many observations are pending and NO attempt was ever recorded', async () => {
    const project = await createProject({ title: 'Obs', rootPath: projectDir });
    for (let i = 0; i < 26; i += 1) {
      await appendObservation(project.id);
    }

    const report = await doctor(projectDir);
    const check = report.checks.find((c) => c.id === 'consolidation.health');
    expect(check).toBeDefined();
    expect(check!.status).toBe('warn');
    expect(check!.message).toMatch(/26 observation/);
    expect(check!.message).toMatch(/no consolidation attempt recorded/);
    expect(check!.fix).toBe('memorize consolidate');
  });
});
