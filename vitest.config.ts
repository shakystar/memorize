import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    env: {
      // #44 auto-detects a host CLI (claude/codex) on PATH as the LLM
      // extractor. Force it off suite-wide so tests (and the hook
      // subprocesses they spawn) never run a real agent CLI; tests that
      // exercise backends inject env/detectors explicitly.
      MEMORIZE_LLM_BACKEND: 'off'
    }
  }
});
