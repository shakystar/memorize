/**
 * Path A (B) — personal/project classification accuracy.
 *
 * Runs the REAL extractor (whatever resolveConsolidatorBackend picks — here the
 * host `claude -p` CLI) over a labeled set of short conversations, each planted
 * with one clearly-personal OR clearly-project fact, then scores the extractor's
 * `personal` flag against the gold label. Reports the confusion matrix and the
 * two error rates that matter for Path A:
 *   - LEAK (personal→project): a personal fact left in project memory (#181 class).
 *   - OVER-DIVERT (project→personal): a project fact wrongly pulled into the
 *     private store, lost from shared memory.
 *
 * The extractor runs in a NEUTRAL temp cwd (no CLAUDE.md) so it classifies the
 * dialogue on its own merits, not as "the memorize repo's coding agent".
 *
 * Usage: pnpm tsx scripts/eval/personal-classification-eval.ts [--limit N] [--concurrency K]
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CliConsolidator,
  type ExtractedMemory,
  resolveConsolidatorBackend,
} from '../../src/services/consolidate-service.js';

type Gold = 'personal' | 'project';

interface EvalCase {
  id: string;
  gold: Gold;
  /** Conversation handed to the extractor as the transcript tail. */
  conversation: string;
  /** Identifies the extracted item(s) about the planted fact. */
  topic: RegExp;
  /** edge cases test the "bias to project when unsure" rule; reported apart. */
  edge?: boolean;
}

const CASES: EvalCase[] = [
  // --- clearly PERSONAL (cross-project facts about the user) ---------------
  {
    id: 'P1-comm-style',
    gold: 'personal',
    topic: /sentence|fragment|문장|telegraph/i,
    conversation:
      'User: From now on, in every project, always answer me in full sentences — never telegraphic fragments.\nAgent: Understood, I will use complete sentences.',
  },
  {
    id: 'P2-tool-pref',
    gold: 'personal',
    topic: /ripgrep|pnpm|grep|npm/i,
    conversation:
      'User: A general habit of mine: I always use ripgrep instead of grep and pnpm instead of npm, on all my repos.\nAgent: Noted, ripgrep and pnpm it is.',
  },
  {
    id: 'P3-identity',
    gold: 'personal',
    topic: /backend|rust|go|engineer/i,
    conversation:
      "User: For context about me: I'm a backend engineer and I mainly work in Rust and Go across all my projects.\nAgent: Got it.",
  },
  {
    id: 'P4-standing-directive',
    gold: 'personal',
    topic: /irreversible|pause|ask|confirm/i,
    conversation:
      'User: This applies everywhere, not just here — before any irreversible action, pause and ask me first.\nAgent: Understood, I will always confirm first.',
  },
  {
    id: 'P5-language-pref',
    gold: 'personal',
    topic: /korean|한국어|language/i,
    conversation:
      'User: 나는 어느 프로젝트에서든 한국어로 소통하는 걸 선호해.\nAgent: 네, 한국어로 진행하겠습니다.',
  },
  {
    id: 'P6-life-fact',
    gold: 'personal',
    topic: /vegetarian|peanut|allerg/i,
    conversation:
      "User: Just so you know for any recipe suggestions, I'm vegetarian and allergic to peanuts.\nAgent: I'll keep that in mind.",
  },
  // --- clearly PROJECT (specific to this project's work) -------------------
  {
    id: 'J1-arch-decision',
    gold: 'project',
    topic: /sqlite|event[- ]?sourc|event log/i,
    conversation:
      "User: For this project's storage, let's go with SQLite plus an event-sourcing log as the source of truth.\nAgent: Okay, event log with SQLite it is.",
  },
  {
    id: 'J2-ci-gate',
    gold: 'project',
    topic: /ci|3[- ]?os|merge|main/i,
    conversation:
      'User: For this repo, nothing merges to main until the 3-OS CI is green.\nAgent: Understood, the 3-OS gate blocks merge here.',
  },
  {
    id: 'J3-progress',
    gold: 'project',
    topic: /auth|oauth|session/i,
    conversation:
      'User: Did you finish the auth module?\nAgent: Yes — today I wired OAuth and the session store for this service.',
  },
  {
    id: 'J4-convention',
    gold: 'project',
    topic: /domain|adapter|import/i,
    conversation:
      'User: Convention in this codebase: all domain types live under src/domain, and domain must never import from adapters.\nAgent: Noted, domain stays adapter-free.',
  },
  {
    id: 'J5-dependency',
    gold: 'project',
    topic: /better-sqlite3|pinned|native|12/i,
    conversation:
      'User: We pinned better-sqlite3 to 12.x in this project because of the native build issues.\nAgent: Right, better-sqlite3 stays on 12.x here.',
  },
  {
    id: 'J6-bugfix',
    gold: 'project',
    topic: /watermark|race|consolidat/i,
    conversation:
      'User: I just fixed the watermark race where two boundaries double-consolidated the same window.\nAgent: Good — the watermark race is resolved.',
  },
  // --- EDGE: a preference expressed inside a project decision (bias→project) -
  {
    id: 'E1-pref-in-project',
    gold: 'project',
    edge: true,
    topic: /strict|typescript|tsconfig/i,
    conversation:
      "User: I prefer TypeScript strict mode — let's enable it for this project.\nAgent: Enabling strict mode in this project's tsconfig.",
  },
  {
    id: 'E2-personal-in-project-ctx',
    gold: 'personal',
    edge: true,
    topic: /review|small|pr|commit/i,
    conversation:
      'User: A rule I keep on every project: I like small, focused PRs and frequent commits.\nAgent: Understood, small PRs and frequent commits.',
  },
];

interface CaseResult {
  id: string;
  gold: Gold;
  edge: boolean;
  predicted: Gold | 'missed';
  matchedText?: string;
  itemCount: number;
}

function classifyFromItems(
  items: ExtractedMemory[],
  topic: RegExp,
): { predicted: Gold | 'missed'; matchedText?: string } {
  const matches = items.filter((i) => topic.test(i.text));
  const pool = matches.length > 0 ? matches : [];
  if (pool.length === 0) return { predicted: 'missed' };
  // Majority of matched items; ties → personal (conservative: surfaces a leak
  // as a non-leak only when the model is decisively project).
  const personalCount = pool.filter((i) => i.personal === true).length;
  const predicted: Gold =
    personalCount * 2 >= pool.length ? 'personal' : 'project';
  return { predicted, matchedText: pool[0]!.text };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf('--limit');
  const limit = limitArg !== -1 ? Number(args[limitArg + 1]) : CASES.length;
  const concArg = args.indexOf('--concurrency');
  const concurrency = concArg !== -1 ? Number(args[concArg + 1]) : 4;

  const backend = resolveConsolidatorBackend();
  if (backend.kind === 'rule-based') {
    throw new Error(
      'No LLM extractor available (rule-based fallback cannot classify). ' +
        'Install claude/codex on PATH or set MEMORIZE_LLM_API_KEY.',
    );
  }
  // Neutral cwd: no CLAUDE.md, so the extractor does not self-identify as this repo.
  const neutralCwd = mkdtempSync(join(tmpdir(), 'memorize-cls-eval-'));
  const consolidator =
    backend.kind === 'cli'
      ? new CliConsolidator({ command: backend.command, cwd: neutralCwd })
      : // For an HTTP backend, cwd is irrelevant; reuse the default extractor.
        new CliConsolidator({ command: 'claude', cwd: neutralCwd });

  const cases = CASES.slice(0, limit);
  process.stderr.write(
    `Running ${cases.length} cases via ${backend.kind === 'cli' ? `cli:${backend.command}` : backend.kind} (concurrency ${concurrency})…\n`,
  );

  const results = await mapLimit<EvalCase, CaseResult>(
    cases,
    concurrency,
    async (c) => {
      let items: ExtractedMemory[] = [];
      // Retry once: a transient empty/garbled reply is an extraction-reliability
      // issue (measured elsewhere), not the classification signal we want here.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          items = await consolidator.extract({
            observations: [],
            transcriptTail: c.conversation,
            existingMemories: [],
          });
          break;
        } catch (error) {
          if (attempt === 1) {
            process.stderr.write(
              `WARN: extract failed for ${c.id} after retry: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
        }
      }
      const { predicted, matchedText } = classifyFromItems(items, c.topic);
      process.stderr.write(`  ${c.id}: ${predicted} (gold ${c.gold})\n`);
      return {
        id: c.id,
        gold: c.gold,
        edge: c.edge ?? false,
        predicted,
        ...(matchedText ? { matchedText } : {}),
        itemCount: items.length,
      };
    },
  );

  const clear = results.filter((r) => !r.edge);
  const scored = clear.filter((r) => r.predicted !== 'missed');
  const missed = clear.filter((r) => r.predicted === 'missed');

  // Confusion matrix on the clear cases that produced a matched item.
  let leak = 0; // personal gold, predicted project
  let overDivert = 0; // project gold, predicted personal
  let correct = 0;
  for (const r of scored) {
    if (r.gold === r.predicted) correct++;
    else if (r.gold === 'personal') leak++;
    else overDivert++;
  }

  const pct = (n: number, d: number) =>
    d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}%`;

  console.log('\n=== Per-case ===');
  for (const r of results) {
    const mark = r.predicted === 'missed' ? '—' : r.gold === r.predicted ? '✓' : '✗';
    console.log(
      `${mark} ${r.id.padEnd(24)} gold=${r.gold.padEnd(8)} pred=${r.predicted.padEnd(8)} items=${r.itemCount}${r.edge ? '  (edge)' : ''}`,
    );
  }

  console.log('\n=== Clear-case classification accuracy ===');
  console.log(`scored: ${scored.length}/${clear.length} (missed extraction: ${missed.length})`);
  console.log(`correct:       ${correct}/${scored.length} (${pct(correct, scored.length)})`);
  console.log(
    `LEAK (personal→project):       ${leak}  [personal fact left in shared project memory]`,
  );
  console.log(
    `OVER-DIVERT (project→personal): ${overDivert}  [project fact pulled into private store]`,
  );

  const edges = results.filter((r) => r.edge);
  if (edges.length > 0) {
    console.log('\n=== Edge cases (bias-to-project rule; reported, not scored) ===');
    for (const r of edges) {
      console.log(`  ${r.id}: gold=${r.gold} pred=${r.predicted}`);
    }
  }

  console.log(
    `\nJSON: ${JSON.stringify({ scored: scored.length, correct, leak, overDivert, missed: missed.length })}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
