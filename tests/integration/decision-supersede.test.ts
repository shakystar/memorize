import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProject,
  recordDecision,
  supersedeDecision,
} from '../../src/services/project-service.js';
import { getDecision } from '../../src/services/projection-store.js';
import { readProject } from '../../src/services/project-service.js';
import { readEvents } from '../../src/storage/event-store.js';
import { closeAll } from '../../src/storage/db.js';

let sandbox: string;
let memorizeRoot: string;
let previousMemorizeRoot: string | undefined;

beforeEach(async () => {
  // realpath: macOS os.tmpdir() is a symlink (/var -> /private/var); the
  // bindings store keys by absolute path, so the in-process and spawned-CLI
  // views must agree (this exact gap broke #156 on macOS CI).
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-decsup-')));
  memorizeRoot = join(sandbox, '.memorize-home');
  previousMemorizeRoot = process.env.MEMORIZE_ROOT;
  process.env.MEMORIZE_ROOT = memorizeRoot;
});

afterEach(async () => {
  if (previousMemorizeRoot === undefined) delete process.env.MEMORIZE_ROOT;
  else process.env.MEMORIZE_ROOT = previousMemorizeRoot;
  closeAll();
  await rm(sandbox, { recursive: true, force: true });
});

describe('decision supersede (append-only correction)', () => {
  it('supersedes a recorded decision, preserving the original', async () => {
    const project = await createProject({ title: 'Sup', rootPath: sandbox });
    const a = await recordDecision({
      projectId: project.id,
      title: 'Use MySQL',
      decision: 'Adopt MySQL',
      rationale: 'familiarity',
      actor: 'user',
    });

    const eventsBefore = await readEvents(project.id);
    const aAcceptedEvent = eventsBefore.find(
      (e) => e.type === 'decision.accepted' && e.scopeId === a.id,
    );
    expect(aAcceptedEvent).toBeDefined();

    const { decision: b, supersededId } = await supersedeDecision({
      projectId: project.id,
      supersedesId: a.id,
      title: 'Use SQLite',
      decision: 'Adopt better-sqlite3',
      rationale: 'embedded, zero-config',
      reason: 'MySQL was overkill for an embedded tool',
      actor: 'user',
    });
    expect(supersededId).toBe(a.id);

    // Original decision row preserved + marked superseded.
    const storedA = getDecision(project.id, a.id);
    expect(storedA?.status).toBe('superseded');
    expect(storedA?.supersededBy).toBe(b.id);

    // New decision is accepted.
    const storedB = getDecision(project.id, b.id);
    expect(storedB?.status).toBe('accepted');

    // Projection: B accepted, A no longer.
    const refreshed = await readProject(project.id);
    expect(refreshed?.acceptedDecisionIds).toContain(b.id);
    expect(refreshed?.acceptedDecisionIds).not.toContain(a.id);

    // Append-only: exactly 3 new events, original accepted event untouched.
    const eventsAfter = await readEvents(project.id);
    expect(eventsAfter.length).toBe(eventsBefore.length + 3);
    const newTypes = eventsAfter
      .slice(eventsBefore.length)
      .map((e) => e.type);
    expect(newTypes).toEqual([
      'decision.proposed',
      'decision.accepted',
      'decision.superseded',
    ]);
    // The original decision.accepted event for A is still present, unmutated.
    const aAcceptedStill = eventsAfter.find((e) => e.id === aAcceptedEvent!.id);
    expect(aAcceptedStill).toEqual(aAcceptedEvent);
  });

  it('throws when superseding an unknown decision id', async () => {
    const project = await createProject({ title: 'Sup', rootPath: sandbox });
    await expect(
      supersedeDecision({
        projectId: project.id,
        supersedesId: 'dec_does_not_exist',
        title: 'x',
        decision: 'y',
      }),
    ).rejects.toThrow();
  });

  it('throws when superseding an already-superseded decision', async () => {
    const project = await createProject({ title: 'Sup', rootPath: sandbox });
    const a = await recordDecision({
      projectId: project.id,
      title: 'A',
      decision: 'a',
      actor: 'user',
    });
    await supersedeDecision({
      projectId: project.id,
      supersedesId: a.id,
      title: 'B',
      decision: 'b',
    });
    await expect(
      supersedeDecision({
        projectId: project.id,
        supersedesId: a.id,
        title: 'C',
        decision: 'c',
      }),
    ).rejects.toThrow();
  });
});
