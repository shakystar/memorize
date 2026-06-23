import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { doctor } from '../../src/services/repair-service.js';
import {
  defaultRefreshDeps,
  recordUpdateCheck,
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
    // The full current contract is present. detectHookCommandForm() chooses
    // the form (npx when memorize is off PATH, else the #122 node-abs form);
    // this test pins migration behavior, not the literal shape, so match any
    // memorize hook command for the event.
    const isMemorizeFor = (cmd: string, event: string): boolean =>
      new RegExp(`(?:memorize\\s+hook|/cli/index\\.js"\\s+hook)\\s+claude\\s+${event}\\b`).test(cmd);
    for (const event of ['SessionStart', 'PostCompact', 'SessionEnd', 'PostToolUse']) {
      const commands = (settings.hooks[event] ?? []).flatMap((g) =>
        g.hooks.map((h) => h.command),
      );
      expect(commands.some((c) => isMemorizeFor(c, event))).toBe(true);
    }
    // The legacy npx entry was migrated to a single current-form entry — no
    // duplicate left behind.
    const startCommands = settings.hooks.SessionStart!.flatMap((g) =>
      g.hooks.map((h) => h.command),
    );
    expect(
      startCommands.filter((c) => isMemorizeFor(c, 'SessionStart')),
    ).toHaveLength(1);
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

describe('doctor update.version line', () => {
  it('unbound directory still fails doctor (update.version must not mask project.bound)', async () => {
    const unbound = join(sandbox, 'unbound');
    await mkdir(unbound, { recursive: true });
    const report = await doctor(unbound);
    expect(report.status).toBe('error');
    expect(
      report.checks.find((c) => c.id === 'project.bound')?.status,
    ).toBe('error');
  });

  it('always reports the CLI version as a non-failing check', async () => {
    const report = await doctor(repo);
    const check = report.checks.find((c) => c.id === 'update.version');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok'); // info-only: never flips doctor to exit 1
  });

  it('mentions the newer cached version when one is known', async () => {
    await recordUpdateCheck({ npmCapture: async () => '999.0.0\n' });
    const report = await doctor(repo);
    const check = report.checks.find((c) => c.id === 'update.version')!;
    expect(check.message).toContain('999.0.0');
    expect(check.message).toContain('memorize update');
    expect(check.status).toBe('ok');
  });
});
