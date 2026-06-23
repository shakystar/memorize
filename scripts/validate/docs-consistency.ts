import { readFile } from 'node:fs/promises';

/**
 * Docs-consistency validator (#85 follow-up). Code is the source of truth;
 * docs must keep up. Every check below pins a drift class that REAL users
 * actually hit:
 *
 * 1. Unscoped `npx memorize` — resolves to a stranger's npm package
 *    (caught in the launch-polish pass).
 * 2. Stale hook-contract claims — AGENT_GUIDE said "SessionStart only" /
 *    "SessionStart and Stop" long after the CLS contract shipped (#81);
 *    PreCompact lingered in docs after retirement (#85).
 * 3. CLI surface drift — usage.ts or a README advertising commands that
 *    don't exist, or commands missing from AGENT_GUIDE entirely.
 * 4. i18n lag — translated READMEs carrying an older day-to-day block
 *    than the English one (caught the day after the #85 demotion).
 *
 * Output mirrors package-dry-run.ts: JSON {status, failures[]}, consumed by
 * tests/integration/docs-consistency.test.ts. Always exits 0 — the report
 * carries the verdict.
 */

const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

const I18N_READMES = [
  'docs/i18n/README.ko.md',
  'docs/i18n/README.ja.md',
  'docs/i18n/README.zh-CN.md',
  'docs/i18n/README.es.md',
];

const ALL_DOCS = [
  'README.md',
  'AGENT_GUIDE.md',
  'docs/ARCHITECTURE.md',
  'guides/AI_SETUP.md',
  '.github/CONTRIBUTING.md',
  ...I18N_READMES,
];

const read = (path: string): Promise<string> => readFile(path, 'utf8');

// --- extract the source-of-truth contracts ----------------------------------

/** Hook-event arrays from install-service.ts (the install contract). */
function extractEventArray(source: string, constName: string): string[] {
  const match = source.match(
    new RegExp(`const ${constName} = \\[([^\\]]*)\\]`, 's'),
  );
  if (!match) {
    fail(`could not extract ${constName} from install-service.ts`);
    return [];
  }
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** Command names from the cli/index.ts handlers map. */
function extractHandlerCommands(source: string): string[] {
  const match = source.match(
    /const handlers: Record<string, CommandHandler> = \{([^}]*)\}/s,
  );
  if (!match) {
    fail('could not extract handlers map from cli/index.ts');
    return [];
  }
  return [...match[1]!.matchAll(/^\s*'?([\w-]+)'?:/gm)].map((m) => m[1]!);
}

const installService = await read('src/services/install-service.ts');
const cliIndex = await read('src/cli/index.ts');
const usage = await read('src/cli/usage.ts');

const claudeEvents = extractEventArray(installService, 'CLAUDE_HOOK_EVENTS');
const codexEvents = extractEventArray(installService, 'CODEX_HOOK_EVENTS');
const claudeLegacy = extractEventArray(
  installService,
  'CLAUDE_LEGACY_MEMORIZE_HOOK_EVENTS',
);
// `version` is special-cased in main() before the handlers map.
const commands = new Set([...extractHandlerCommands(cliIndex), 'version']);

// --- 1+2: forbidden stale claims across all docs ----------------------------

const FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  {
    // `npx memorize <something>` without the scope — a stranger's package.
    pattern: /npx memorize(?![\w-])/,
    reason:
      'unscoped `npx memorize` resolves to an unrelated npm package — use `npx @shakystar/memorize`',
  },
  {
    pattern: /registers\s+`SessionStart`\s+only/,
    reason: 'stale codex hook claim ("registers SessionStart only") — see #81',
  },
  {
    pattern: /`SessionStart`\s+and\s+`Stop`\s+hook/,
    reason: 'stale codex hook claim ("SessionStart and Stop") — see #81',
  },
  {
    // A doc bullet still advertising PreCompact as a registered hook.
    pattern: /`PreCompact`\s*(→|->)/,
    reason: 'PreCompact left the hook contract in #85',
  },
];

for (const doc of ALL_DOCS) {
  const text = await read(doc);
  for (const { pattern, reason } of FORBIDDEN) {
    for (const line of text.split('\n')) {
      // Lines that WARN about the stale form are legitimate mentions.
      if (pattern.test(line) && !/bare|unscoped|unrelated|stranger|legacy/i.test(line)) {
        fail(`${doc}: ${reason}`);
        break;
      }
    }
  }
}

// Retired events must not reappear in the live contract.
for (const event of claudeLegacy) {
  if (claudeEvents.includes(event)) {
    fail(`install-service: '${event}' is both live and legacy for Claude`);
  }
}

// --- 2b: AGENT_GUIDE must name every live hook event ------------------------

const agentGuide = await read('AGENT_GUIDE.md');
for (const event of new Set([...claudeEvents, ...codexEvents])) {
  if (!agentGuide.includes(`\`${event}\``)) {
    fail(`AGENT_GUIDE.md: live hook event \`${event}\` is never mentioned`);
  }
}

// --- 3: CLI surface ----------------------------------------------------------

/**
 * Command tokens in COMMAND CONTEXTS only — backticked invocations and
 * fence/usage lines that start with the binary name. Free prose
 * ("memorize walks upward…") is deliberately not scanned.
 */
function mentionedCommands(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(
    /`(?:npx @shakystar\/)?memorize\s+([a-z][\w-]*)/g,
  )) {
    found.add(m[1]!);
  }
  for (const m of text.matchAll(
    /^\s*'?\s*(?:npx @shakystar\/)?memorize\s+([a-z][\w-]*)/gm,
  )) {
    found.add(m[1]!);
  }
  return found;
}

for (const source of [
  { name: 'src/cli/usage.ts', text: usage },
  { name: 'README.md', text: await read('README.md') },
  ...(await Promise.all(
    I18N_READMES.map(async (p) => ({ name: p, text: await read(p) })),
  )),
]) {
  for (const cmd of mentionedCommands(source.text)) {
    if (!commands.has(cmd)) {
      fail(
        `${source.name}: advertises \`memorize ${cmd}\` but no such command exists`,
      );
    }
  }
}

// Every real command must be documented in AGENT_GUIDE (the full reference).
for (const cmd of commands) {
  if (!agentGuide.includes(`memorize ${cmd}`)) {
    fail(`AGENT_GUIDE.md: command \`memorize ${cmd}\` is undocumented`);
  }
}

// 3b: every MULTI-WORD command advertised in usage.ts (the curated public
// surface) must ALSO be documented in AGENT_GUIDE. The check above only sees
// top-level handler keys, so new SUBCOMMANDS — `project relocate`, `memory
// show`, `task done`, `conflict resolve`, `project decision add` — would
// otherwise drift undocumented exactly the way they did before this guard.
function usageSubcommandPaths(text: string): Set<string> {
  const paths = new Set<string>();
  for (const line of text.split('\n')) {
    // Leading lowercase command tokens only; stops at a `<placeholder>`,
    // `...`, or the capitalized aligned description. `+` ⇒ 2+ tokens.
    const m = line.match(/memorize\s+((?:[a-z][\w-]*)(?:\s+[a-z][\w-]*)+)/);
    if (m) paths.add(m[1]!);
  }
  return paths;
}

for (const path of usageSubcommandPaths(usage)) {
  if (!agentGuide.includes(`memorize ${path}`)) {
    fail(
      `AGENT_GUIDE.md: subcommand \`memorize ${path}\` (advertised in usage.ts) is undocumented`,
    );
  }
}

// --- 4: i18n day-to-day parity -----------------------------------------------

/** `memorize …` lines inside the first day-to-day ```sh fence of a README. */
function dayToDayCommands(text: string): string[] {
  const fences = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map(
    (m) => m[1]!,
  );
  // The day-to-day block is the one whose lines start with the bare binary
  // (the install fence starts with `npx`/`curl`).
  const block = fences.find((f) => /^memorize\s/m.test(f)) ?? '';
  return [...block.matchAll(/^memorize\s+([a-z][\w-]*(?:\s+[a-z][\w-]*)?)/gm)]
    .map((m) => `memorize ${m[1]!.trim()}`);
}

const englishDayToDay = dayToDayCommands(await read('README.md'));
if (englishDayToDay.length === 0) {
  fail('README.md: could not locate the day-to-day command block');
}
for (const i18n of I18N_READMES) {
  const text = await read(i18n);
  for (const line of englishDayToDay) {
    if (!text.includes(line)) {
      fail(`${i18n}: day-to-day block lags README.md — missing \`${line}\``);
    }
  }
}

// --- report -------------------------------------------------------------------

console.log(
  JSON.stringify(
    { status: failures.length === 0 ? 'pass' : 'fail', failures },
    null,
    2,
  ),
);
