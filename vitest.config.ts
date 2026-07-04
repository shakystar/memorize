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
      MEMORIZE_LLM_BACKEND: 'off',
      // #46 detaches boundary consolidation into a background child by
      // default. Force the old synchronous inline behavior suite-wide so
      // hook-lifecycle tests keep deterministic boundaries; tests that
      // exercise the detached path delete this var explicitly.
      MEMORIZE_CONSOLIDATE_INLINE: '1',
      // session-start update notice spawns a detached registry probe by
      // default; force it off suite-wide so hook tests never spawn real
      // children or touch the network. update-notice tests re-enable it
      // by deleting this var explicitly.
      MEMORIZE_UPDATE_CHECK_DISABLED: '1',
      // SessionStart spawns the detached watcher-sync loop (SoT-042/043) by
      // default; force it off suite-wide so hook tests never leave a live
      // polling child behind. watcher tests exercise spawnDetachedWatcher
      // with an injected spawnImpl and delete this var explicitly.
      MEMORIZE_WATCHER_DISABLED: '1',
      // win32 shadow-loads better_sqlite3.node from ~/.memorize/runtime so a
      // running process can't lock the global install (mid-session update).
      // Force it off suite-wide so the general suite stays byte-identical and
      // skips the per-open addon copy; native-addon tests inject deps or delete
      // this var explicitly.
      MEMORIZE_NATIVE_SHADOW_DISABLED: '1'
    }
  }
});
