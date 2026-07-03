import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTaskRequest } from '../../src/domain/entities.js';
import type { Project } from '../../src/domain/entities.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

const HUB = 'proj_cli_hub';

let sandbox: string;
let memorizeRoot: string;

function runCli(args: string[], input?: string) {
  return spawnSync(process.execPath, [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: { ...process.env, MEMORIZE_ROOT: memorizeRoot },
    ...(input !== undefined ? { input } : {}),
  });
}

function bindProject(): string {
  const start = runCli(
    ['hook', 'claude', 'SessionStart'],
    JSON.stringify({
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'taskreq-cli-uuid-1',
    }),
  );
  expect(start.status).toBe(0);
  const show = runCli(['project', 'show']);
  expect(show.status).toBe(0);
  return (JSON.parse(show.stdout) as { id: string }).id;
}

/** Land the hub member's genesis + an inbound request in the local union. */
async function seedInbound(selfProjectId: string): Promise<string> {
  await appendEvent({
    type: 'project.created',
    projectId: selfProjectId,
    scopeType: 'project',
    scopeId: HUB,
    actor: 'test',
    sourceProjectId: HUB,
    payload: { id: HUB, title: 'memorize_hub' } as unknown as Project,
  });
  const request = createTaskRequest({
    projectId: HUB,
    targetProjectId: selfProjectId,
    title: 'Inbound from hub',
    goal: 'delegated',
  });
  // NOTE: `projectId` here names the PHYSICAL store `appendEvent` writes into
  // (`getDb(input.projectId)`); `sourceProjectId` is the provenance tag
  // `reduceProjectState`'s lane-folding actually keys off. To simulate a
  // synced-in foreign event landing in this store's own union log, this must
  // physically target selfProjectId (like the genesis append above) while
  // stamping `sourceProjectId: HUB` for provenance — NOT `projectId: HUB`,
  // which would silently write into a separate physical db that selfProjectId's
  // `rebuildProjectProjection` never reads.
  await appendEvent({
    type: 'task.requested',
    projectId: selfProjectId,
    scopeType: 'project',
    scopeId: request.id,
    actor: 'hub-agent',
    writer: 'hub-agent',
    sourceProjectId: HUB,
    payload: request,
  });
  await rebuildProjectProjection(selfProjectId);
  closeAll(); // release the in-process handle before the CLI child opens it
  return request.id;
}

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-taskreqcli-')));
  memorizeRoot = join(sandbox, '.memorize-home');
  process.env.MEMORIZE_ROOT = memorizeRoot;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize task request (CLI)', () => {
  it('creates an outbound request addressed by member title, without sync configured', async () => {
    const selfId = bindProject();
    await seedInbound(selfId); // hub genesis makes 'memorize_hub' addressable

    const created = runCli([
      'task', 'request', 'Ship the roster endpoint',
      '--to', 'memorize_hub',
      '--goal', 'unblock slice 2',
      '--ac', 'roster visible',
    ]);
    expect(created.status).toBe(0);
    expect(created.stdout).toMatch(/Created task request taskreq_\S+ -> memorize_hub/);
    // No transport configured: honest note, no throw (autoPush degrades).
    expect(created.stdout).toMatch(/sync not configured/);

    const listed = runCli(['task', 'request', 'list', '--outbound']);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain('Ship the roster endpoint');
    expect(listed.stdout).toContain('pending');
  });

  it('routes a reserved-word title to create when --to is present', async () => {
    const selfId = bindProject();
    await seedInbound(selfId); // hub genesis makes 'memorize_hub' addressable

    // 'list' is also an action word — the --to flag must disambiguate this
    // as a create, not misroute it into the list handler.
    const created = runCli([
      'task', 'request', 'list', 'of', 'demands',
      '--to', 'memorize_hub',
    ]);
    expect(created.status).toBe(0);
    expect(created.stdout).toMatch(/Created task request taskreq_\S+ -> memorize_hub/);

    const listed = runCli(['task', 'request', 'list', '--outbound']);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain('list of demands');

    // Plain `task request list` (no --to) still routes to the list handler.
    const plainList = runCli(['task', 'request', 'list']);
    expect(plainList.status).toBe(0);
    expect(plainList.stdout).toContain('list of demands');
  });

  it('routes a reserved-word title to create when the --to= equals form is used', async () => {
    const selfId = bindProject();
    await seedInbound(selfId); // hub genesis makes 'memorize_hub' addressable

    // parseFlags also accepts `--to=<ref>`; the dispatcher must treat that
    // spelling as create too, not misroute into the list handler.
    const created = runCli([
      'task', 'request', 'list', 'of', 'demands', 'two',
      '--to=memorize_hub',
    ]);
    expect(created.status).toBe(0);
    expect(created.stdout).toMatch(/Created task request taskreq_\S+ -> memorize_hub/);

    const listed = runCli(['task', 'request', 'list', '--outbound']);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain('list of demands two');
  });

  it('declines with --reason and surfaces the reason in the declined list', async () => {
    const selfId = bindProject();
    const requestId = await seedInbound(selfId);

    const declined = runCli([
      'task', 'request', 'decline', requestId,
      '--reason', 'already shipped',
    ]);
    expect(declined.status).toBe(0);
    expect(declined.stdout).toMatch(/Declined request/);

    const listed = runCli([
      'task', 'request', 'list', '--inbound', '--status', 'declined',
    ]);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain(requestId);
    expect(listed.stdout).toContain('already shipped');
  });

  it('accept mints a local task; decline requires --reason', async () => {
    const selfId = bindProject();
    const requestId = await seedInbound(selfId);

    const inbox = runCli(['task', 'request', 'list', '--inbound']);
    expect(inbox.status).toBe(0);
    expect(inbox.stdout).toContain(requestId);

    const accepted = runCli(['task', 'request', 'accept', requestId]);
    expect(accepted.status).toBe(0);
    const m = accepted.stdout.match(/Created task (task_\S+) from request/);
    expect(m).toBeTruthy();

    const tasks = runCli(['task', 'list']);
    expect(tasks.stdout).toContain('Inbound from hub');

    // decline without --reason fails loud (the reason flows back, SoT-041).
    const badDecline = runCli(['task', 'request', 'decline', requestId]);
    expect(badDecline.status).not.toBe(0);
  });

  it('rejects a request without --to', () => {
    bindProject();
    const result = runCli(['task', 'request', 'No target']);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/--to/);
  });

  it('workspace sources lists addressable member projects, marking self', async () => {
    const selfId = bindProject();
    await seedInbound(selfId);

    const sources = runCli(['workspace', 'sources']);
    expect(sources.status).toBe(0);
    expect(sources.stdout).toContain(selfId);
    expect(sources.stdout).toContain('(self)');
    expect(sources.stdout).toContain('memorize_hub');

    const asJson = runCli(['workspace', 'sources', '--json']);
    expect(asJson.status).toBe(0);
    const parsed = JSON.parse(asJson.stdout) as Array<{ id: string; isSelf: boolean }>;
    expect(parsed.some((p) => p.id === HUB && p.isSelf === false)).toBe(true);
  });

  it('task resume surfaces pending inbound requests as the inbox', async () => {
    const selfId = bindProject();
    const requestId = await seedInbound(selfId);

    const resume = runCli(['task', 'resume']);
    expect(resume.status).toBe(0);
    const payload = JSON.parse(resume.stdout) as {
      inboundTaskRequests?: Array<{ id: string; fromProjectId: string }>;
    };
    expect(payload.inboundTaskRequests?.map((r) => r.id)).toEqual([requestId]);
    expect(payload.inboundTaskRequests?.[0]?.fromProjectId).toBe(HUB);
  });

  it('caps the inbox at the 5 oldest pending requests and truncates title/goal', async () => {
    // Read-side guard (SoT-041): write-side guards only bind an honest local
    // writer, so a malicious/buggy member syncing a flood of oversized
    // task.requested events must still be bounded at the point the inbox is
    // consumed for injection. Seven pending requests, oldest-first createdAt
    // stamps, first request carrying oversized title/goal text.
    const selfId = bindProject();
    await appendEvent({
      type: 'project.created',
      projectId: selfId,
      scopeType: 'project',
      scopeId: HUB,
      actor: 'test',
      sourceProjectId: HUB,
      payload: { id: HUB, title: 'memorize_hub' } as unknown as Project,
    });

    const total = 7;
    const requestIds: string[] = [];
    for (let i = 0; i < total; i++) {
      const ts = `2026-07-01T00:00:0${i}.000Z`;
      const request = {
        ...createTaskRequest({
          projectId: HUB,
          targetProjectId: selfId,
          title: i === 0 ? 'T'.repeat(250) : `Request ${i}`,
          goal: i === 0 ? 'G'.repeat(600) : `goal ${i}`,
        }),
        createdAt: ts,
        updatedAt: ts,
      };
      requestIds.push(request.id);
      await appendEvent({
        type: 'task.requested',
        projectId: selfId,
        scopeType: 'project',
        scopeId: request.id,
        actor: 'hub-agent',
        writer: 'hub-agent',
        sourceProjectId: HUB,
        payload: request,
      });
    }
    await rebuildProjectProjection(selfId);
    closeAll();

    const resume = runCli(['task', 'resume']);
    expect(resume.status).toBe(0);
    const payload = JSON.parse(resume.stdout) as {
      inboundTaskRequests?: Array<{ id: string; title: string; goal: string }>;
      inboundTaskRequestsOmitted?: number;
    };

    // The 5 OLDEST survive (deterministic; oldest = most escalated), not an
    // arbitrary or newest-first subset.
    expect(payload.inboundTaskRequests?.map((r) => r.id)).toEqual(
      requestIds.slice(0, 5),
    );
    expect(payload.inboundTaskRequestsOmitted).toBe(2);

    // title 200 chars / goal 500 chars + ellipsis at the consumption boundary.
    const first = payload.inboundTaskRequests?.[0];
    expect(first?.title.length).toBe(201);
    expect(first?.title.endsWith('…')).toBe(true);
    expect(first?.goal.length).toBe(501);
    expect(first?.goal.endsWith('…')).toBe(true);
  });
});
