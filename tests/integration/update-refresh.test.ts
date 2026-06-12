import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultRefreshDeps,
  runRefresh,
} from '../../src/services/update-service.js';
import { setupProject } from '../../src/services/setup-service.js';
import { closeAll } from '../../src/storage/db.js';
import { readEvents } from '../../src/storage/event-store.js';
import { writeJson } from '../../src/storage/fs-utils.js';

let sandbox: string;
let repo: string;
let savedForm: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-refresh-'));
  process.env.MEMORIZE_ROOT = join(sandbox, 'root');
  // Deterministic hook command form regardless of the test machine's PATH.
  savedForm = process.env.MEMORIZE_HOOK_COMMAND_FORM;
  process.env.MEMORIZE_HOOK_COMMAND_FORM = 'bare';
  repo = join(sandbox, 'repo');
  await mkdir(join(repo, '.claude'), { recursive: true });
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  if (savedForm === undefined) delete process.env.MEMORIZE_HOOK_COMMAND_FORM;
  else process.env.MEMORIZE_HOOK_COMMAND_FORM = savedForm;
  await rm(sandbox, { recursive: true, force: true });
});

interface HooksFile {
  hooks: Record<
    string,
    Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
  >;
}

describe('runRefresh end-to-end (sandboxed)', () => {
  it('migrates legacy claude hooks, preserves third-party entries, never shrinks the event log', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), 'project rules v1\n', 'utf8');
    const { project } = await setupProject(repo);

    // Legacy install state: retired Stop event + a third-party hook that
    // must survive byte-for-byte.
    await writeJson(join(repo, '.claude', 'settings.local.json'), {
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'memorize hook claude Stop' }],
          },
        ],
        SessionStart: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: 'npx @shakystar/memorize hook claude SessionStart' },
            ],
          },
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'other-tool --on-start' }],
          },
        ],
      },
    });

    const eventsBefore = (await readEvents(project.id)).length;

    const result = await runRefresh({
      ...defaultRefreshDeps(),
      // No codex install in the sandbox — points at a nonexistent file.
      codexHooksFile: () => join(sandbox, 'codex-hooks.json'),
    });

    expect(result.codexRefreshed).toBe(false);
    expect(result.claudeRefreshed).toEqual([repo]);
    expect(result.failures).toEqual([]);

    const settings = JSON.parse(
      await readFile(join(repo, '.claude', 'settings.local.json'), 'utf8'),
    ) as HooksFile;

    // Legacy Stop entry (memorize-only) is gone entirely.
    expect(settings.hooks.Stop).toBeUndefined();
    // The full current contract is present.
    for (const event of ['SessionStart', 'PostCompact', 'SessionEnd', 'PostToolUse']) {
      const commands = (settings.hooks[event] ?? []).flatMap((g) =>
        g.hooks.map((h) => h.command),
      );
      expect(commands).toContain(`memorize hook claude ${event}`);
    }
    // npx form was migrated to bare — no duplicate npx entry left.
    const startCommands = settings.hooks.SessionStart!.flatMap((g) =>
      g.hooks.map((h) => h.command),
    );
    expect(startCommands.filter((c) => c.includes('hook claude SessionStart'))).toEqual(
      ['memorize hook claude SessionStart'],
    );
    // Third-party entry survived.
    expect(startCommands).toContain('other-tool --on-start');

    // install added the ground-rule block to CLAUDE.md -> body changed ->
    // the idempotent re-import picks it up (and ONLY appends events).
    expect(result.reimported).toEqual([
      { projectId: project.id, rootPath: repo, count: 1 },
    ]);

    // Data preservation: the event log never shrinks.
    expect((await readEvents(project.id)).length).toBeGreaterThanOrEqual(
      eventsBefore,
    );
  });

  it('skips projects without memorize hooks (never fresh-installs)', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), 'rules\n', 'utf8');
    await setupProject(repo); // bound project, but NO hooks installed

    const result = await runRefresh({
      ...defaultRefreshDeps(),
      codexHooksFile: () => join(sandbox, 'codex-hooks.json'),
    });
    expect(result.claudeRefreshed).toEqual([]);
  });
});
