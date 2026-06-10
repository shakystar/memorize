import { describe, expect, it } from 'vitest';

import { createObservation } from '../../src/domain/entities.js';
import {
  ExtractionParseError,
  RuleBasedConsolidator,
  parseExtractedMemories,
  resolveLlmConfig,
} from '../../src/services/consolidate-service.js';

const projectId = 'proj_clsunit_test1';

describe('RuleBasedConsolidator (degraded extractor — decision ①)', () => {
  it('aggregates write-tool observations into one progress memory', async () => {
    const consolidator = new RuleBasedConsolidator();
    const extracted = await consolidator.extract({
      observations: [
        createObservation({
          projectId,
          signal: 'write-tool',
          toolName: 'Write',
          summary: 'Write: /repo/a.ts',
        }),
        createObservation({
          projectId,
          signal: 'write-tool',
          toolName: 'Edit',
          summary: 'Edit: /repo/b.ts',
        }),
      ],
      existingMemories: [],
    });

    const progress = extracted.filter((m) => m.kind === 'progress');
    expect(progress).toHaveLength(1);
    expect(progress[0]!.text).toContain('/repo/a.ts');
    expect(progress[0]!.text).toContain('/repo/b.ts');
  });

  it('maps decision-keyword observations to decision memories with higher salience', async () => {
    const consolidator = new RuleBasedConsolidator();
    const extracted = await consolidator.extract({
      observations: [
        createObservation({
          projectId,
          signal: 'decision-keyword',
          toolName: 'Bash',
          summary: 'FTS5 대신 LIKE 검색 하기로 결정',
        }),
        createObservation({
          projectId,
          signal: 'mutating-bash',
          toolName: 'Bash',
          summary: 'git commit -m "wip"',
        }),
      ],
      existingMemories: [],
    });

    const decision = extracted.find((m) => m.kind === 'decision');
    expect(decision?.text).toContain('FTS5');
    const progress = extracted.find((m) => m.kind === 'progress');
    expect(decision!.salience).toBeGreaterThan(progress!.salience);
  });

  it('extracts nothing from an empty window', async () => {
    const consolidator = new RuleBasedConsolidator();
    expect(
      await consolidator.extract({ observations: [], existingMemories: [] }),
    ).toEqual([]);
  });
});

describe('parseExtractedMemories (defensive LLM reply parsing)', () => {
  it('parses a clean JSON array', () => {
    const parsed = parseExtractedMemories(
      '[{"kind":"decision","text":"Use sqlite","salience":8}]',
    );
    expect(parsed).toEqual([
      { kind: 'decision', text: 'Use sqlite', salience: 8 },
    ]);
  });

  it('locates the array inside surrounding prose', () => {
    const parsed = parseExtractedMemories(
      'Here you go:\n[{"kind":"progress","text":"Did x","salience":3}]\nDone.',
    );
    expect(parsed).toHaveLength(1);
  });

  it('drops malformed entries, clamps salience, ignores unknown kinds', () => {
    const parsed = parseExtractedMemories(
      JSON.stringify([
        { kind: 'decision', text: 'ok', salience: 99 },
        { kind: 'vibe', text: 'bad kind', salience: 5 },
        { kind: 'progress', text: '', salience: 5 },
        { kind: 'rationale' }, // no text
        'not an object',
      ]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.salience).toBe(10);
  });

  it('throws ExtractionParseError for unparseable content (extractor FAILURE, not an empty result)', () => {
    expect(() => parseExtractedMemories('no array here')).toThrow(
      ExtractionParseError,
    );
    expect(() => parseExtractedMemories('[{broken json')).toThrow(
      ExtractionParseError,
    );
  });

  it('returns [] for a genuinely empty array reply (clean result)', () => {
    expect(parseExtractedMemories('[]')).toEqual([]);
    expect(parseExtractedMemories('Nothing durable here.\n[]')).toEqual([]);
  });

  it('keeps supersede fields when present', () => {
    const parsed = parseExtractedMemories(
      JSON.stringify([
        {
          kind: 'decision',
          text: 'new direction',
          salience: 7,
          supersedesMemoryId: 'mem_old',
          supersedeReason: 'reversed',
        },
      ]),
    );
    expect(parsed[0]!.supersedesMemoryId).toBe('mem_old');
    expect(parsed[0]!.supersedeReason).toBe('reversed');
  });
});

describe('parseExtractedMemories — #57 observe-only lifecycle evidence', () => {
  it('keeps well-formed evidence fields; tags are trimmed, lowercased, deduped', () => {
    const parsed = parseExtractedMemories(
      JSON.stringify([
        {
          kind: 'progress',
          text: 'Gate before merge: run verify:full',
          salience: 9,
          obsoleteWhen: '  when the merge happens  ',
          kindMisfit: true,
          kindMisfitReason: 'standing constraint, not progress',
          supersedesNote: 'replaces the earlier informal gate note',
          tags: [' Constraint ', 'GATE', 'constraint'],
        },
      ]),
    );
    expect(parsed[0]).toMatchObject({
      obsoleteWhen: 'when the merge happens',
      kindMisfit: true,
      kindMisfitReason: 'standing constraint, not progress',
      supersedesNote: 'replaces the earlier informal gate note',
      tags: ['constraint', 'gate'],
    });
  });

  it('drops malformed evidence WITHOUT failing the entry (#43 tolerance contract)', () => {
    const parsed = parseExtractedMemories(
      JSON.stringify([
        {
          kind: 'decision',
          text: 'ok',
          salience: 5,
          obsoleteWhen: 42, // wrong type → absent
          kindMisfit: 'yes', // not boolean true → absent
          kindMisfitReason: 'reason without the flag', // dropped with the flag
          supersedesNote: '   ', // blank → absent
          tags: 'constraint', // not an array → absent
        },
      ]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ kind: 'decision', text: 'ok', salience: 5 });
  });

  it('filters junk inside tags and caps the count', () => {
    const parsed = parseExtractedMemories(
      JSON.stringify([
        {
          kind: 'progress',
          text: 'ok',
          salience: 4,
          tags: [1, null, ' a ', 'b', '', 'c', 'd', 'e', 'f'],
        },
      ]),
    );
    expect(parsed[0]!.tags).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('honors the maxItems override (#69 import raises the boundary cap)', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      kind: 'progress',
      text: `item ${i}`,
      salience: 4,
    }));
    expect(parseExtractedMemories(JSON.stringify(items))).toHaveLength(12);
    expect(
      parseExtractedMemories(JSON.stringify(items), { maxItems: 25 }),
    ).toHaveLength(25);
  });

  it('an all-junk tags array reads as absent, not empty', () => {
    const parsed = parseExtractedMemories(
      JSON.stringify([
        { kind: 'progress', text: 'ok', salience: 4, tags: [7, null, '  '] },
      ]),
    );
    expect(parsed[0]!.tags).toBeUndefined();
  });
});

describe('resolveLlmConfig (key-optional — decision ①)', () => {
  it('returns undefined without a key (rule-based fallback path)', () => {
    expect(resolveLlmConfig({})).toBeUndefined();
  });

  it('applies endpoint/model defaults around a provided key', () => {
    const config = resolveLlmConfig({ MEMORIZE_LLM_API_KEY: 'sk-test' });
    expect(config?.endpoint).toBe('https://api.anthropic.com/v1');
    expect(config?.model).toBe('claude-haiku-4-5');
  });

  it('honors a local OpenAI-compatible endpoint (Ollama-style)', () => {
    const config = resolveLlmConfig({
      MEMORIZE_LLM_API_KEY: 'ollama',
      MEMORIZE_LLM_ENDPOINT: 'http://localhost:11434/v1',
      MEMORIZE_LLM_MODEL: 'qwen3:8b',
    });
    expect(config).toEqual({
      endpoint: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'qwen3:8b',
    });
  });

  it('reads MEMORIZE_LLM_TIMEOUT_MS into timeoutMs (local CPU models need >20s)', () => {
    const config = resolveLlmConfig({
      MEMORIZE_LLM_API_KEY: 'sk-test',
      MEMORIZE_LLM_TIMEOUT_MS: '120000',
    });
    expect(config?.timeoutMs).toBe(120_000);
  });

  it('ignores invalid or non-positive MEMORIZE_LLM_TIMEOUT_MS values', () => {
    for (const value of ['abc', '0', '-5', '']) {
      const config = resolveLlmConfig({
        MEMORIZE_LLM_API_KEY: 'sk-test',
        MEMORIZE_LLM_TIMEOUT_MS: value,
      });
      expect(config?.timeoutMs).toBeUndefined();
    }
  });
});
