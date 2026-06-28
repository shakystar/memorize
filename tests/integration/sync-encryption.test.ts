import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileSyncTransport } from '../../src/adapters/sync-transport-file.js';
import { createProject } from '../../src/services/project-service.js';
import { createTask } from '../../src/services/task-service.js';
import {
  cloneProject,
  pushProject,
  updateSyncState,
} from '../../src/services/sync-service.js';
import { generateProjectKey, isEncryptedEnvelope } from '../../src/services/encryption-service.js';
import { closeAll } from '../../src/storage/db.js';
import { readEvents } from '../../src/storage/event-store.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-sync-enc-'));
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

// True-replica machines share a projectId; getDb caches by projectId, so we drop
// the cache when switching MEMORIZE_ROOT (mirrors sync-roundtrip.test.ts).
function useMachine(root: string): void {
  closeAll();
  process.env.MEMORIZE_ROOT = root;
}

const SECRET_TITLE = 'launch-the-rocket-at-dawn';

describe('E2E payload encryption over sync (#182)', () => {
  it('relay sees ciphertext, keyed clone reads plaintext', async () => {
    const remotePath = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const key = generateProjectKey();

    // A: create a project, turn on encryption, add a secret task, push.
    useMachine(homeA);
    const projectA = await createProject({
      title: 'Project A',
      rootPath: join(sandbox, 'a'),
    });
    await updateSyncState(projectA.id, { encryptionKey: key });
    await createTask({ projectId: projectA.id, title: SECRET_TITLE, actor: 'user' });

    const transport = createFileSyncTransport(remotePath);
    const push = await pushProject(projectA.id, transport);
    expect(push.accepted.length).toBeGreaterThan(0);

    // The relay's on-disk NDJSON must carry __enc envelopes, not the secret.
    const wire = await readFile(join(remotePath, projectA.id, 'events.ndjson'), 'utf8');
    expect(wire).not.toContain(SECRET_TITLE);
    const wireEvents = wire
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; payload: unknown });
    const taskEvent = wireEvents.find((e) => e.type === 'task.created');
    expect(taskEvent).toBeDefined();
    expect(isEncryptedEnvelope(taskEvent?.payload)).toBe(true);

    // B: clone WITH the key → clone-time pull decrypts to plaintext locally.
    useMachine(homeB);
    const clone = await cloneProject(
      join(sandbox, 'b'),
      projectA.id,
      transport,
      undefined,
      key,
    );
    expect(clone.pulled).toBeGreaterThan(0);

    const local = await readEvents(projectA.id);
    const localTask = local.find((e) => e.type === 'task.created');
    expect(localTask).toBeDefined();
    expect(isEncryptedEnvelope(localTask?.payload)).toBe(false);
    expect((localTask?.payload as { title: string }).title).toBe(SECRET_TITLE);
  });

  it('un-keyed project still round-trips plaintext (compat)', async () => {
    const remotePath = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');

    useMachine(homeA);
    const projectA = await createProject({
      title: 'Project A',
      rootPath: join(sandbox, 'a'),
    });
    await createTask({ projectId: projectA.id, title: SECRET_TITLE, actor: 'user' });
    const transport = createFileSyncTransport(remotePath);
    await pushProject(projectA.id, transport);

    // No key passed → plaintext on the wire.
    const wire = await readFile(join(remotePath, projectA.id, 'events.ndjson'), 'utf8');
    expect(wire).toContain(SECRET_TITLE);

    useMachine(homeB);
    const clone = await cloneProject(join(sandbox, 'b'), projectA.id, transport);
    expect(clone.pulled).toBeGreaterThan(0);
    const local = await readEvents(projectA.id);
    expect(local.some((e) => e.type === 'task.created')).toBe(true);
  });
});
