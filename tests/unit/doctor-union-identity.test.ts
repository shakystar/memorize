import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import type { DomainEvent } from '../../src/domain/events.js';
import type { Project } from '../../src/domain/entities.js';
import { createProject } from '../../src/services/project-service.js';
import { doctor } from '../../src/services/repair-service.js';
import { closeAll } from '../../src/storage/db.js';
import { insertExternalEvents } from '../../src/storage/event-store.js';

// W-b (SoT-021/022): after a workspace union pull, the store legitimately holds
// every member's `project.created` as a provenance label. Doctor's #30
// identity check must count SELF-lane genesis only — a foreign genesis is not a
// cross-machine clobber and must not flip doctor to error.

let sandbox: string;
let cwd: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-doctor-union-'));
  process.env.MEMORIZE_ROOT = join(sandbox, 'root');
  cwd = join(sandbox, 'proj');
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

const ts = '2026-05-01T00:00:00.000Z';

function foreignGenesis(
  id: string,
  sourceProjectId?: string,
  eventProjectId?: string,
): DomainEvent {
  const payload: Project = {
    id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    title: id,
    summary: `${id} store`,
    goals: [],
    status: 'active',
    rootPath: `/tmp/${id}`,
    importedContextCount: 0,
    activeWorkstreamIds: [],
    activeTaskIds: [],
    acceptedDecisionIds: [],
    ruleIds: [],
  };
  return {
    id: `evt_genesis_${id}`,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    type: 'project.created',
    projectId: eventProjectId ?? id,
    scopeType: 'project',
    scopeId: id,
    actor: 'test',
    ...(sourceProjectId ? { sourceProjectId } : {}),
    payload,
  } as DomainEvent;
}

function identityCheck(checks: { id: string; status: string }[]) {
  return checks.find((c) => c.id === 'project.identity');
}

describe('doctor project.identity (union-aware, W-b)', () => {
  it('stays ok when a FOREIGN member genesis is carried in by a union pull', async () => {
    const project = await createProject({ title: 'self', rootPath: cwd });

    await insertExternalEvents(project.id, [
      foreignGenesis('proj_member_bob', 'proj_member_bob'),
    ]);

    const report = await doctor(cwd);
    expect(identityCheck(report.checks)?.status).toBe('ok');
  });

  it('stays ok when a foreign member LEGACY genesis (no provenance) rides a union pull', async () => {
    const project = await createProject({ title: 'self', rootPath: cwd });

    // The 3.0.0 dogfood regression: a member's whole-DB push carries its
    // pre-provenance events with NULL source_project_id as-is. The event still
    // rides under the member's own project_id, so it must not read as self.
    await insertExternalEvents(project.id, [foreignGenesis('proj_member_legacy')]);

    const report = await doctor(cwd);
    expect(identityCheck(report.checks)?.status).toBe('ok');
  });

  it('still errors on a divergent genesis stamped with THIS store provenance', async () => {
    const project = await createProject({ title: 'self', rootPath: cwd });

    // A different identity explicitly claiming this store's lane is a genuine
    // self-lane divergence, not union provenance.
    await insertExternalEvents(project.id, [
      foreignGenesis('proj_clobber', project.id),
    ]);

    const report = await doctor(cwd);
    expect(identityCheck(report.checks)?.status).toBe('error');
  });

  it('still errors on a legacy divergent genesis riding under THIS store project_id', async () => {
    const project = await createProject({ title: 'self', rootPath: cwd });

    // NULL provenance + this store's own project_id column + a different
    // payload id: the event claims self-lane residency for another identity.
    await insertExternalEvents(project.id, [
      foreignGenesis('proj_clobber', undefined, project.id),
    ]);

    const report = await doctor(cwd);
    expect(identityCheck(report.checks)?.status).toBe('error');
  });
});
