import { describe, expect, it } from 'vitest';

import { createObservation } from '../../src/domain/entities.js';
import {
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

  it('returns [] for unparseable content', () => {
    expect(parseExtractedMemories('no array here')).toEqual([]);
    expect(parseExtractedMemories('[{broken json')).toEqual([]);
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
});
