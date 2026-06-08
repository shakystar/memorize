import { describe, expect, it } from 'vitest';

import {
  evaluateCapture,
  extractApplyPatchPaths,
  parsePostToolUsePayload,
} from '../../src/services/capture-service.js';

describe('CLS capture filter (decision ③ — conservative whitelist)', () => {
  it('captures Write/Edit/MultiEdit as write-tool signals with a structured filePath', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const verdict = evaluateCapture(tool, '/repo/src/index.ts');
      expect(verdict.capture).toBe(true);
      expect(verdict.signal).toBe('write-tool');
      expect(verdict.summary).toContain('/repo/src/index.ts');
      expect(verdict.filePath).toBe('/repo/src/index.ts');
    }
  });

  it('captures codex apply_patch edits as write-tool signals (vendor symmetry)', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '-const a = 1;',
      '+const a = 2;',
      '*** End Patch',
    ].join('\n');
    const verdict = evaluateCapture('apply_patch', patch);
    expect(verdict.capture).toBe(true);
    expect(verdict.signal).toBe('write-tool');
    expect(verdict.filePath).toBe('src/app.ts');
    expect(verdict.summary).toContain('src/app.ts');
  });

  it('extractApplyPatchPaths pulls Add/Update/Delete/Move paths', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '*** Update File: src/old.ts',
      '*** Move to: src/renamed.ts',
      '*** Delete File: src/gone.ts',
      '*** End Patch',
    ].join('\n');
    expect(extractApplyPatchPaths(patch)).toEqual([
      'src/new.ts',
      'src/old.ts',
      'src/renamed.ts',
      'src/gone.ts',
    ]);
    // First path becomes the observation's filePath; full list in summary.
    const verdict = evaluateCapture('apply_patch', patch);
    expect(verdict.filePath).toBe('src/new.ts');
    expect(verdict.summary).toContain('src/old.ts');
  });

  it('still captures apply_patch even when the body is not a recognizable patch', () => {
    const verdict = evaluateCapture('apply_patch', 'garbled non-patch text');
    expect(verdict.capture).toBe(true);
    expect(verdict.signal).toBe('write-tool');
    expect(verdict.filePath).toBeUndefined();
  });

  it('rejects read-only tools outright', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch']) {
      expect(evaluateCapture(tool, 'anything at all').capture).toBe(false);
    }
  });

  it('captures mutating Bash commands but not read-only ones', () => {
    expect(evaluateCapture('Bash', 'git commit -m "feat: x"').signal).toBe(
      'mutating-bash',
    );
    expect(evaluateCapture('Bash', 'npm install left-pad').signal).toBe(
      'mutating-bash',
    );
    expect(evaluateCapture('Bash', 'rm -rf build').signal).toBe('mutating-bash');

    expect(evaluateCapture('Bash', 'ls -la').capture).toBe(false);
    expect(evaluateCapture('Bash', 'git status').capture).toBe(false);
    expect(evaluateCapture('Bash', 'cat README.md').capture).toBe(false);
  });

  it('captures memorize task transitions with their own signal', () => {
    const verdict = evaluateCapture('Bash', 'memorize task update t1 --status done');
    expect(verdict.signal).toBe('task-transition');
  });

  it('captures decision keywords in Bash commands (Korean + English seeds)', () => {
    expect(evaluateCapture('Bash', 'echo "FTS5 대신 LIKE 검색 하기로 결정"').signal).toBe(
      'decision-keyword',
    );
    expect(
      evaluateCapture('Bash', 'echo "decided to use sqlite instead of postgres"')
        .signal,
    ).toBe('decision-keyword');
  });

  it('clips over-long summaries', () => {
    const verdict = evaluateCapture('Write', 'x'.repeat(1000));
    expect(verdict.summary!.length).toBeLessThanOrEqual(240);
  });
});

describe('PostToolUse payload parsing (defensive)', () => {
  it('extracts tool_name, command, and transcript_path', () => {
    const parsed = parsePostToolUsePayload(
      JSON.stringify({
        session_id: 'abc',
        transcript_path: '/tmp/t.jsonl',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
      }),
    );
    expect(parsed.toolName).toBe('Bash');
    expect(parsed.toolInputText).toBe('git push origin main');
    expect(parsed.transcriptPath).toBe('/tmp/t.jsonl');
  });

  it('falls back to file_path for write tools', () => {
    const parsed = parsePostToolUsePayload(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/repo/a.ts', content: 'export {}' },
      }),
    );
    expect(parsed.toolInputText).toBe('/repo/a.ts');
  });

  it('tolerates malformed JSON and non-object payloads', () => {
    expect(parsePostToolUsePayload('not json').toolInputText).toBe('');
    expect(parsePostToolUsePayload('[1,2]').toolName).toBeUndefined();
    expect(parsePostToolUsePayload(undefined).toolInputText).toBe('');
  });
});
