# Changelog

All notable changes to `@shakystar/memorize` are recorded here.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
loosely. The project adheres to [Semantic Versioning](https://semver.org/);
major-version bumps are reserved for breaking changes to the on-disk event
log layout or the public CLI surface.

> **This file is maintained by
> [release-please](https://github.com/googleapis/release-please).** New
> sections are generated from Conventional Commits and prepended below
> when a Release PR is merged — do not edit version sections or add
> entries by hand. See
> [CONTRIBUTING.md](.github/CONTRIBUTING.md#releasing).

## [3.0.0](https://github.com/shakystar/memorize/compare/v2.5.0...v3.0.0) (2026-07-03)


### Features

* **3.0.0:** M1 local accounts + per-account personal store; W1 personal cross-device sync ([#221](https://github.com/shakystar/memorize/issues/221)) ([e53b5cc](https://github.com/shakystar/memorize/commit/e53b5cc15aadef38c7a51c2d0d9a12067bb1d891))
* **auth:** browser device-auth login (RFC 8628), replacing BYO-token ([#231](https://github.com/shakystar/memorize/issues/231)) ([4c294a5](https://github.com/shakystar/memorize/commit/4c294a5627946a28fd9e08e3a718cd49aa87fa18))
* **cli:** git-style onboarding — clone/remote accept Hub URLs ([#238](https://github.com/shakystar/memorize/issues/238)) ([98d9f18](https://github.com/shakystar/memorize/commit/98d9f1809d09aaf333f904ec95b490b0e984d4a3))
* **memory:** memory gc — physical reclamation of un-pushed retracted memories (3.0.0 M3-b, SoT-050) ([#228](https://github.com/shakystar/memorize/issues/228)) ([9e13860](https://github.com/shakystar/memorize/commit/9e13860f6eb5146e9957f6179ea7b4af0931b9b0))
* **memory:** memory revert --session — consolidated revert (3.0.0 M3-c, SoT-050) ([#229](https://github.com/shakystar/memorize/issues/229)) ([0988b79](https://github.com/shakystar/memorize/commit/0988b796e392035125b07678c568037a123c288b))
* **memory:** memory.retracted tombstone (3.0.0 M3-a, SoT-050) ([#227](https://github.com/shakystar/memorize/issues/227)) ([10959c1](https://github.com/shakystar/memorize/commit/10959c13b5b5ed7e0fa58f1e44d794d58eb289df))
* **projection:** source-keyed (entity,writer) lane projection (3.0.0 M2) ([#222](https://github.com/shakystar/memorize/issues/222)) ([5458663](https://github.com/shakystar/memorize/commit/5458663e176099aa3af2cbe9123d64bb47a5292e))
* **sync:** W-b full reconcile — legacy proj_ bindings converge to canonical wsp_ (3.0.0 M4-b, SoT-031) ([#235](https://github.com/shakystar/memorize/issues/235)) ([54bd2b3](https://github.com/shakystar/memorize/commit/54bd2b312d127af1694522021c56e5b966a3e0cb))
* **task:** fill-path for task fields — create flags, task.item-appended, honest empty defaults ([#236](https://github.com/shakystar/memorize/issues/236)) ([b3e21c8](https://github.com/shakystar/memorize/commit/b3e21c851aa1f72c25673c8dba88bb00d1ba0337))
* **workspace:** 3.0.0 M4 — workspace identity + union sync + invite/join (W-a/b/d) ([#232](https://github.com/shakystar/memorize/issues/232)) ([cde51f0](https://github.com/shakystar/memorize/commit/cde51f01ebc03645baa7bb595fb3666f75897c18))
* **workspace:** 3.0.0 M4 W-c — owner global retract gate, role-cache refresh, role management CLI ([#234](https://github.com/shakystar/memorize/issues/234)) ([9661b87](https://github.com/shakystar/memorize/commit/9661b87b7614f14b634d4aeb7b7229bc256b9be2))
* **workspace:** W3 shared memory channel — union-lane sharedMemories injection with its own budget pool ([#237](https://github.com/shakystar/memorize/issues/237)) ([c113c0f](https://github.com/shakystar/memorize/commit/c113c0f209353503e15bf75e35c015d1d5fb8603))


### Bug Fixes

* **cli:** force fatal CLI errors to exit ([#241](https://github.com/shakystar/memorize/issues/241)) ([833858c](https://github.com/shakystar/memorize/commit/833858cfffd23bd794634d778f3f5b541dc6fe24))
* **cli:** harden WSL interop and sync push output ([#240](https://github.com/shakystar/memorize/issues/240)) ([31027ec](https://github.com/shakystar/memorize/commit/31027ec22dacd9ca74f17e312487e7a6ba5f1041))
* **genesis:** self-heal missing project.created at SessionStart ([#230](https://github.com/shakystar/memorize/issues/230)) ([d80c68a](https://github.com/shakystar/memorize/commit/d80c68a4504fd3c152e51e4bad1b79b810ff36c4))


### Miscellaneous Chores

* pin next release line to 3.0.0 ([e716d99](https://github.com/shakystar/memorize/commit/e716d99dd86007aa7ef92f5d5d9554a2d1aff0c1))

## [2.5.0](https://github.com/shakystar/memorize/compare/v2.4.0...v2.5.0) (2026-06-30)


### Features

* **benchmark:** aggregative-recall localization harness (graph-recovery, miss-analysis, extraction-recall) ([#187](https://github.com/shakystar/memorize/issues/187)) ([c1ba612](https://github.com/shakystar/memorize/commit/c1ba612a7ca9eb07ad3a578ddfb9077792c42f25))
* **benchmark:** consolidation-ON e2e harness on LongMemEval-S ([#183](https://github.com/shakystar/memorize/issues/183)) ([55e628d](https://github.com/shakystar/memorize/commit/55e628d39921aaf5e1823867bbb84e719e22e521))
* **benchmark:** counting-track harness (count accuracy 3-way + extraction-miss audit) ([#189](https://github.com/shakystar/memorize/issues/189)) ([eaaf41e](https://github.com/shakystar/memorize/commit/eaaf41e52cf2be893818c0443e3ca342438ffe37))
* **benchmark:** end-to-end QA-accuracy harness on LongMemEval-S ([#177](https://github.com/shakystar/memorize/issues/177)) ([d1d924b](https://github.com/shakystar/memorize/commit/d1d924b2ee23a502aee72967e279d1fb4a4510b7))
* **benchmark:** Phase 0 bottleneck-localization harness (oracle ablation + gold-coverage) ([#186](https://github.com/shakystar/memorize/issues/186)) ([2f906b1](https://github.com/shakystar/memorize/commit/2f906b14d4a1eddbc641542c1e5ff3140c7acc04))
* **benchmark:** resumable e2e QA-accuracy harness on LongMemEval-S (official protocol) ([#179](https://github.com/shakystar/memorize/issues/179)) ([b98ebd2](https://github.com/shakystar/memorize/commit/b98ebd21dd0fb6555c7a90a7bc8a97d80b5a7251))
* **benchmark:** retrieval-recall harness on LongMemEval-S (bm25 + hybrid) ([#170](https://github.com/shakystar/memorize/issues/170)) ([daddb4c](https://github.com/shakystar/memorize/commit/daddb4c93466ec7571f481a625bdfc8a3e0384ec))
* **benchmark:** temporal/sum codegen harness — measures TReMu codegen vs raw reader ([#190](https://github.com/shakystar/memorize/issues/190)) ([7800f1e](https://github.com/shakystar/memorize/commit/7800f1e7b0a4212c8261b50ab8dc56c60aae56f9))
* **consolidate:** generalize the memory extractor out of the coding-only domain ([#181](https://github.com/shakystar/memorize/issues/181)) ([ac7c1a6](https://github.com/shakystar/memorize/commit/ac7c1a6f59c03d86780550b67e0223ae03b17186))
* **cursor:** integrate Cursor coding agent (json-hooks-map, project-scoped, full lifecycle) + conformance ([#212](https://github.com/shakystar/memorize/issues/212)) ([7e33ffc](https://github.com/shakystar/memorize/commit/7e33ffcb382e51a3528c4dbce8d48396b541b07c))
* **gemini:** integrate Gemini CLI (json-hooks-map) + generalize the hooks writer ([#197](https://github.com/shakystar/memorize/issues/197)) ([5e9a75f](https://github.com/shakystar/memorize/commit/5e9a75ff8192446ce77f3450655dbb7f1ab94efa))
* **hermes:** integrate Hermes coding agent (yaml-shell-hooks, full 3-pillar) ([#203](https://github.com/shakystar/memorize/issues/203)) ([ca92ea0](https://github.com/shakystar/memorize/commit/ca92ea037d3f1c6350c68202912ca7ffb29be975))
* multi-harness foundation — harness registry + memorize mcp server ([#188](https://github.com/shakystar/memorize/issues/188)) ([049b7e9](https://github.com/shakystar/memorize/commit/049b7e96d68ffd9ce1b7fc58fc77fd4ee9b9e876))
* **opencode:** integrate opencode harness + Docker conformance automation ([#194](https://github.com/shakystar/memorize/issues/194)) ([b12cff8](https://github.com/shakystar/memorize/commit/b12cff8ded2088c22d132ba33de30bf4934aa6bb))
* **personal:** global personal-memory pipeline (Path A) — capture → store → injection ([#214](https://github.com/shakystar/memorize/issues/214)) ([8d4385a](https://github.com/shakystar/memorize/commit/8d4385af0ea903a3944f63641c9d918c85506f67))
* **pi:** integrate pi coding agent (ts-plugin, full session-start injection) ([#199](https://github.com/shakystar/memorize/issues/199)) ([8eb2b67](https://github.com/shakystar/memorize/commit/8eb2b679febd83b6c5ad13663185c1390d82959b))
* **retrieval:** raw transcript segments — verbatim detail retrievable alongside consolidated memories ([#193](https://github.com/shakystar/memorize/issues/193)) ([3c81488](https://github.com/shakystar/memorize/commit/3c8148867556207dc8d3172ea216f8a28086d9d0))
* **sync:** CLI provisioning for E2E payload encryption keys ([#182](https://github.com/shakystar/memorize/issues/182)) ([#198](https://github.com/shakystar/memorize/issues/198)) ([44a7ed1](https://github.com/shakystar/memorize/commit/44a7ed10de46ee3cff7223c13b6f4a19d46e8132))
* **sync:** client-side E2E encryption of synced event payloads ([#182](https://github.com/shakystar/memorize/issues/182)) ([#195](https://github.com/shakystar/memorize/issues/195)) ([bfc3606](https://github.com/shakystar/memorize/commit/bfc3606ab5bf203a20114896eac8830075af6362))
* **sync:** finish [#192](https://github.com/shakystar/memorize/issues/192) — fail-fast auth-login validation + token anti-sprawl ([#202](https://github.com/shakystar/memorize/issues/202)) ([321a450](https://github.com/shakystar/memorize/commit/321a450f0b0fce356b0e019cc43b6f9f971ed890))
* **sync:** host-level credential store + `memorize auth login` ([#192](https://github.com/shakystar/memorize/issues/192)) ([#200](https://github.com/shakystar/memorize/issues/200)) ([7715042](https://github.com/shakystar/memorize/commit/7715042fbd30a7b30ebfa2d1094855d5bd0ad191))


### Bug Fixes

* **benchmark:** fire CLI entry guard via pathToFileURL (Windows) ([#173](https://github.com/shakystar/memorize/issues/173)) ([96d74d8](https://github.com/shakystar/memorize/commit/96d74d88f9da7bb5f97b9856b5924d58dc33f104))
* **consolidate:** tighten extractor scope classification (personal vs project) ([#181](https://github.com/shakystar/memorize/issues/181)) ([#217](https://github.com/shakystar/memorize/issues/217)) ([88b96e4](https://github.com/shakystar/memorize/commit/88b96e41ac28ad975d958f62ecfdf3744a4c3775))
* **embeddings:** split oversized embed batches to fit model context ([#174](https://github.com/shakystar/memorize/issues/174)) ([3747de3](https://github.com/shakystar/memorize/commit/3747de37829f3331bb87c5ddbcd002ecd23b3d68))
* **install:** recognize legacy resolved-binary (.cmd shim) hook form so re-install dedups instead of accumulating ([#211](https://github.com/shakystar/memorize/issues/211)) ([8f791fe](https://github.com/shakystar/memorize/commit/8f791fe344112362bc72b54023ef39f2857ef584))
* keep mcp context read-only when unbound ([7f68fac](https://github.com/shakystar/memorize/commit/7f68facccc627304c319b49b46f0df2b96eb575f))
* **realtime-share:** scan sibling git ops by window, not the post-watermark delta ([#168](https://github.com/shakystar/memorize/issues/168)) ([#206](https://github.com/shakystar/memorize/issues/206)) ([4a4f8d8](https://github.com/shakystar/memorize/commit/4a4f8d83076aa9a623c3a25664748a0f2b1f90d1))
* redact sync status encryption key ([c27ff3c](https://github.com/shakystar/memorize/commit/c27ff3ccceeaf2cea95d9cdee34327c90bbd7a6c))
* **search:** OR-join FTS tokens so NL queries return results ([#178](https://github.com/shakystar/memorize/issues/178)) ([811903d](https://github.com/shakystar/memorize/commit/811903d072f76be1f5e6c95c2930cd97edee13e0))
* **sync:** fail closed when pulling encrypted payloads without a key ([#195](https://github.com/shakystar/memorize/issues/195), [#198](https://github.com/shakystar/memorize/issues/198)) ([#205](https://github.com/shakystar/memorize/issues/205)) ([adccffa](https://github.com/shakystar/memorize/commit/adccffa4c27741e68223b79f3628589b8865116e))
* **task:** `task resume` accepts an explicit --task/&lt;id&gt; target and rejects unknown flags ([#209](https://github.com/shakystar/memorize/issues/209)) ([6030786](https://github.com/shakystar/memorize/commit/60307860b38cdeb906be82799dfc7c14e84fa2fd))
* **task:** fail loud when task resume --task &lt;id&gt; does not resolve ([#210](https://github.com/shakystar/memorize/issues/210)) ([f1222c3](https://github.com/shakystar/memorize/commit/f1222c3fd68547e0eff90de1650bed1570a43b86))

## [2.4.0](https://github.com/shakystar/memorize/compare/v2.3.1...v2.4.0) (2026-06-24)


### Features

* **cli:** add decision list/show read command ([#148](https://github.com/shakystar/memorize/issues/148)) ([#161](https://github.com/shakystar/memorize/issues/161)) ([f0ab2f7](https://github.com/shakystar/memorize/commit/f0ab2f7245c58883417f985e95f2224e1a1bc80e))
* **cli:** add project decision supersede correction event ([#148](https://github.com/shakystar/memorize/issues/148) slice 2) ([#158](https://github.com/shakystar/memorize/issues/158)) ([a346f0d](https://github.com/shakystar/memorize/commit/a346f0dc20dc7226521af15f764ad196e3933eea))
* **cli:** task update/cancel, memory list, conflict unknown-subcommand rejection ([#148](https://github.com/shakystar/memorize/issues/148) slice 1) ([#156](https://github.com/shakystar/memorize/issues/156)) ([4e5f25d](https://github.com/shakystar/memorize/commit/4e5f25d4fe6ef960c593e59d815b7bfc1264ff53))
* **conflict,project:** add producers for modeled-but-unreachable transitions ([#120](https://github.com/shakystar/memorize/issues/120), [#121](https://github.com/shakystar/memorize/issues/121)) ([#133](https://github.com/shakystar/memorize/issues/133)) ([ccf8736](https://github.com/shakystar/memorize/commit/ccf8736f21e6a01725f66b9a98bdccaa598def9c))
* **consolidate:** conversation-complete transcript capture — cat-2 fix ([#99](https://github.com/shakystar/memorize/issues/99)) ([5f8f7e4](https://github.com/shakystar/memorize/commit/5f8f7e440d323540568a6b1d25b377b7901f76db))
* **consolidate:** conversation-complete transcript capture — cat-2 fix ([#99](https://github.com/shakystar/memorize/issues/99)) ([0e7b6eb](https://github.com/shakystar/memorize/commit/0e7b6eba83b220d06b2e1894b5592fd525d5e6a7))
* **consolidate:** read conversation for zero-observation sessions — cat-1 fix ([#99](https://github.com/shakystar/memorize/issues/99)) ([#106](https://github.com/shakystar/memorize/issues/106)) ([813cc79](https://github.com/shakystar/memorize/commit/813cc79457223c09119f6b4b2e628bd51004e326))
* **inject:** demote explicit-coordination blocks below ambient memory ([#85](https://github.com/shakystar/memorize/issues/85)) ([#113](https://github.com/shakystar/memorize/issues/113)) ([50796b2](https://github.com/shakystar/memorize/commit/50796b236f9aa931fee3969df3d77c1ea6972ba1))
* **install:** plant using-memorize skill on Claude install ([#112](https://github.com/shakystar/memorize/issues/112)) ([099a70b](https://github.com/shakystar/memorize/commit/099a70b6bcd74cba6b4e3be268547ce19ad8e94e))
* **memory:** add 'memory show &lt;id&gt;' to read a recalled memory's full text ([#111](https://github.com/shakystar/memorize/issues/111)) ([#138](https://github.com/shakystar/memorize/issues/138)) ([d80d642](https://github.com/shakystar/memorize/commit/d80d642aed0ec5672c40849825f4c3ee4a526629))
* **project:** add 'project relocate' to rebind a moved repo to its existing project ([#124](https://github.com/shakystar/memorize/issues/124)) ([#134](https://github.com/shakystar/memorize/issues/134)) ([326110b](https://github.com/shakystar/memorize/commit/326110bc2bc5b23a156b74e533f8d0b79b66cc43))
* **realtime-share:** warn on concurrent destructive-git collisions across parallel sessions ([#168](https://github.com/shakystar/memorize/issues/168)) ([93fab8f](https://github.com/shakystar/memorize/commit/93fab8fd04c9c6a34101944fe0caf9dd219fedc1))
* **scripts:** decision miss-rate measurement — semantic matcher + classifier ([#99](https://github.com/shakystar/memorize/issues/99)) ([d0c2319](https://github.com/shakystar/memorize/commit/d0c2319e76a4f06d6afa7324601b79dce5559486))
* **scripts:** decision miss-rate measurement tooling for [#99](https://github.com/shakystar/memorize/issues/99) ([a9fff2c](https://github.com/shakystar/memorize/commit/a9fff2c24b77e4d055977fc8f88e08d4c2a518de))


### Bug Fixes

* **capture:** recover session from agent id + transcript scope fallback ([#108](https://github.com/shakystar/memorize/issues/108), [#109](https://github.com/shakystar/memorize/issues/109)) ([#110](https://github.com/shakystar/memorize/issues/110)) ([ec743c6](https://github.com/shakystar/memorize/commit/ec743c6ac35f6e75056e779be9ca117c319cb31d))
* **cli:** handle --help instead of creating a junk task ([#131](https://github.com/shakystar/memorize/issues/131)) ([afe590a](https://github.com/shakystar/memorize/commit/afe590a9e89014567b66836995c0ba8e54aa317c))
* **conflict:** emit conflict.detected with scopeId=conflict.id so resolve rebuild doesn't collide ([#157](https://github.com/shakystar/memorize/issues/157)) ([#160](https://github.com/shakystar/memorize/issues/160)) ([f68411a](https://github.com/shakystar/memorize/commit/f68411ac417e1572b97bf8fc7e15ab645ce560ab))
* **consolidate:** harden extractor against memory-governance instruction-bleed ([#119](https://github.com/shakystar/memorize/issues/119)) ([303e854](https://github.com/shakystar/memorize/commit/303e8545d06101599efb3236297f29f8ca66b138))
* **consolidate:** report resolved backend + outcome instead of misleading extractor:none ([#127](https://github.com/shakystar/memorize/issues/127)) ([#136](https://github.com/shakystar/memorize/issues/136)) ([1fb7878](https://github.com/shakystar/memorize/commit/1fb78789995ab3ae8154392a42ccdd425caf550d))
* **db:** actionable hint when the data dir is unwritable (Codex sandbox) ([#116](https://github.com/shakystar/memorize/issues/116)) ([#144](https://github.com/shakystar/memorize/issues/144)) ([c9343c2](https://github.com/shakystar/memorize/commit/c9343c28f4aa9af9b0631160939ccfe5558a9ce8))
* **doctor:** tolerate UTF-8 BOM in settings.local.json / codex hooks.json ([#102](https://github.com/shakystar/memorize/issues/102) follow-up) ([#153](https://github.com/shakystar/memorize/issues/153)) ([c3ce6be](https://github.com/shakystar/memorize/commit/c3ce6be2504f6daff2ba537157a65788dd27b3eb))
* **doctor:** verify all 4 Claude hooks incl. PostToolUse capture ([#141](https://github.com/shakystar/memorize/issues/141)) ([2ec69a8](https://github.com/shakystar/memorize/commit/2ec69a8b34140252bfeddc1240abad79d316e119))
* **install:** run hooks via absolute node path so Git Bash resolves them ([#122](https://github.com/shakystar/memorize/issues/122), [#123](https://github.com/shakystar/memorize/issues/123), [#130](https://github.com/shakystar/memorize/issues/130)) ([#132](https://github.com/shakystar/memorize/issues/132)) ([528d663](https://github.com/shakystar/memorize/commit/528d663a33572b4feb8c28d889484926da4626eb))
* **release:** match existing v* tags (include-component-in-tag false) ([#147](https://github.com/shakystar/memorize/issues/147)) ([0cb3908](https://github.com/shakystar/memorize/commit/0cb3908e6baa5da31ebd1acdfd40b92f02249f8a))
* **scripts:** sharpen judge — one-off vs standing + acceptance evidence ([#99](https://github.com/shakystar/memorize/issues/99)) ([ffdd785](https://github.com/shakystar/memorize/commit/ffdd785d3102e7ea82d121cb8e16470f4d34b87b))
* **setup:** detect a moved repo and relocate instead of silently orphaning memory ([#145](https://github.com/shakystar/memorize/issues/145)) ([#149](https://github.com/shakystar/memorize/issues/149)) ([a8e7c5e](https://github.com/shakystar/memorize/commit/a8e7c5e8707ea6e5b0af822c102cc3f7ae0ae666))
* **setup:** distinguish exact vs ancestor binding so setup no longer absorbs a subdir into its parent ([#151](https://github.com/shakystar/memorize/issues/151)) ([#155](https://github.com/shakystar/memorize/issues/155)) ([bd66ec0](https://github.com/shakystar/memorize/commit/bd66ec0d620dbf42f17a523ac8a9ede2d95e352a))
* **task:** wire `task done` CLI verb to reach terminal done state ([#118](https://github.com/shakystar/memorize/issues/118)) ([1ef25ac](https://github.com/shakystar/memorize/commit/1ef25aca3d02aab4921e8f158262726d802d3dd5))
* **update:** spawn npm via cross-spawn to drop shell:true and silence DEP0190 ([#96](https://github.com/shakystar/memorize/issues/96)) ([#137](https://github.com/shakystar/memorize/issues/137)) ([766f9dd](https://github.com/shakystar/memorize/commit/766f9dd243a30004d9dfefac3460e3caf9435a31))

## [2.3.1] — 2026-06-13

Windows-only console-noise patch, cut from the `v2.3.0` tag so it carries
none of the unreleased `memorize update` / threshold-consolidation work
(those ship in `2.4.0`). No behavior change off Windows.

### Fixed

- **Background children no longer flash visible console windows on
  Windows** (#102). Boundary-spawned consolidate children (and their
  `claude -p` / `codex exec` grandchildren) and the detached consolidate
  process allocated black, empty console windows that lingered for the
  full extraction. `windowsHide: true` (CREATE_NO_WINDOW) is now set
  everywhere a background child is spawned; no-op on POSIX.
- **The extractor process tree is fully killed on timeout** (Windows).
  `child.kill()` only terminated cross-spawn's `cmd.exe` shim wrapper,
  orphaning the real `claude`/`codex` extractor (and its console window)
  past the 90s timeout. `taskkill /T /F` now takes the whole tree down;
  POSIX keeps the plain `child.kill()`.

## [2.3.0] — 2026-06-11

Shaped end-to-end by the first external user's report (#82): three
parallel sessions, a fourth asking "what are my other sessions doing?",
and no good answer. Additive and backward-compatible.

### Added

- **`memorize session list` / `memorize session activity [--limit N]
  [--json]`** (#83) — on-demand sibling visibility: claiming sessions
  with actor/status/lastSeenAt (asking session marked `self`), and per
  session the recent captured observations. Quiet sessions are shown as
  "(no captured activity yet)" rather than omitted — plan-mode sessions
  mostly read, and read-only tools are deliberately not captured.
- **`memorize version`** (also `--version` / `-v`) — prints the version
  of the binary that actually ran. `npx` resolves a project
  devDependency before the global install, so this is the tool for
  catching the pinned-old-version trap from #82.
- **Docs-consistency check in CI** — a validator pins every docs-drift
  class real users hit (unscoped `npx memorize`, stale hook-contract
  claims, CLI commands advertised-but-missing or shipped-but-
  undocumented, i18n READMEs lagging the English day-to-day block).
  Its first run immediately caught a lingering unscoped-npx warning
  context and three undocumented commands (`search`, `export`,
  `migrate` — now documented in AGENT_GUIDE).

### Changed

- **The explicit-coordination layer is demoted from the front door**
  (#85). Evidence across two machines of dogfooding plus the first
  external user: organic task/handoff/checkpoint usage is zero while
  ambient memory thrives. usage/README now lead with the ambient layer;
  task commands move to an "Explicit coordination (optional)" group;
  AI_SETUP no longer nudges users to create a first task (an empty task
  list is normal); AGENT_GUIDE frames tasks/handoffs as the optional
  layer and steers "what are other sessions doing?" to
  `session activity`, not `task list`.
- **PreCompact retired from the Claude hook contract** (#85): its
  checkpoint-capture role was replaced wholesale by the PostCompact
  consolidation boundary, the handler had long been a no-op, and real
  stores show zero checkpoint events — registering it only spawned a
  useless subprocess per compaction. Legacy entries are stripped on
  re-install; doctor checks the live set only.
- AGENT_GUIDE: stale codex hook wording fixed (#81) — the integration
  registers SessionStart + PostToolUse + PostCompact, not "SessionStart
  only" / "SessionStart and Stop". Caught when the first macOS user's
  agent read the stale lines and rationalized a 1.x install's missing
  hooks as intentional.

## [2.2.0] — 2026-06-10

Additive, backward-compatible. Theme: making memorize the project's
single source of truth in practice — absorb the context that predates it,
and keep new state from leaking back into per-agent memory silos.

### Added

- **`memorize memory import --source <label>`** (#69, PR #70) — the
  ingestion primitive for agent-driven absorption. The agent reads and
  distills pre-existing context (its own harness memory, override files,
  user-named doc folders) into extractor-shaped JSON and pipes it in;
  memorize never reads outside the project tree. Same sanitizers as
  boundary consolidation (#57 lifecycle fields ride along), provenance
  label on every memory, kind+text idempotency guard with
  `skippedDuplicates` reporting, contradiction-checked, ≤100 items per
  call. guides/AI_SETUP.md gains the offer → distill → import → report
  adoption step.
- **Ground-rule planting** (#68, PR #71) — `install claude` / `install
  codex` plant the single-source-of-truth contract as a marker-managed
  block in `CLAUDE.md` / `AGENTS.md` (created when absent, replaced in
  place on re-install, stripped exactly by `uninstall`, file never
  deleted), plus a one-line reminder in every startup injection as a
  fallback for sessions that never read the file.
- **ARCHITECTURE.md** — the technical story (CLS two-layer memory,
  watermark-idempotent consolidation, retrieval-time forgetting, live
  share, cross-machine convergence, the lifecycle-evidence program),
  shipped in the npm tarball. README rewritten around it; issue
  templates + CONTRIBUTING refresh (stale MIT wording → AGPL).

### Fixed

- **Windows one-line installer** (`irm … install.ps1 | iex`) aborted on
  every Windows PowerShell 5.1 shell: nested quotes in the
  `node -p` version probe were mangled by 5.1's native-argument quoting,
  so the check always read 0 and the installer refused valid Node
  installs. It now parses `node -v` in PowerShell itself. (Verified
  end-to-end on 5.1.)

## [2.1.0] — 2026-06-10

Additive, backward-compatible. Centerpiece: the lifecycle-evidence
instrumentation agreed in discussion #61 — collect data first, decide the
memory-taxonomy schema later. Nothing here changes injection, dedup, or
contradiction behavior.

### Added

- **Observe-only lifecycle evidence on extracted memories** (#57, PR #64).
  The consolidation extractor (HTTP and host-CLI backends, one shared
  prompt) may attach `obsoleteWhen` (free-form expiry condition),
  `kindMisfit` + `kindMisfitReason`, `supersedesNote`, and `tags` to each
  memory. Persisted on the `memory.consolidated` event payload (round-trips
  through projection rebuild and sync with no schema change); read by NO
  consumer. A missing or malformed field degrades to "absent" — never an
  extraction failure, and the consolidation watermark behaves exactly as
  before.
- **Behavioral lifecycle telemetry** (#62, PR #65). New
  `memories.injection_count` projection column (migration v9, observe-only,
  carried across routine rebuilds like `last_accessed_at`): startup
  injection counts via the existing reinforcement stamp; mid-session
  live-share delivery counts WITHOUT touching `last_accessed_at` (telemetry
  must not change retrieval ranking). New `memory-telemetry-service` exposes
  per-memory lifecycle rows (superseded/contradicted timestamps + reasons)
  and a kind × behavior aggregation.
- **`memorize consolidate --report`** — dumps both evidence halves as JSON:
  extraction-side (#57: obsolete_when presence × kind, kind-misfit rate +
  reasons, tag × kind) and behavioral (#62: injections, superseded,
  contradicted, deduped, age-at-invalidation distribution per kind).

### Changed

- **doctor: codex trust gap is now inferred, not just described** (#37,
  PR #66). When memorize hooks are registered in `~/.codex/hooks.json` and
  the bound project has sessions from other agents but none from codex,
  `install.codex` raises a `warn` with the one-time interactive approval as
  the fix (codex silently skips externally-written hooks until approved;
  upstream non-interactive trust grant tracked in openai/codex#21615).
  Fresh installs (no sessions at all) are not flagged.
- AGENT_GUIDE: new `memorize consolidate` section (the command existed
  since 2.0.0 but was undocumented); `install codex` gains an ACTION
  REQUIRED block about hook approval. guides/AI_SETUP.md instructs the
  installing agent to relay the approval step to the user.

## [2.0.0] — 2026-06-10

The first AGPL release. Supersedes 1.1.0 (published briefly under MIT, then
unpublished); 2.0.0 carries all of 1.1.0's features (listed under 1.1.0 below)
plus the relicense.

### Changed

- **BREAKING — License: MIT → AGPL-3.0-or-later.** memorize is now copyleft:
  derivative works and network/SaaS deployments must release their complete
  corresponding source under the same license. Versions 1.0.0–1.1.0 were
  published under MIT and remain available under those terms (the grant on
  already-distributed copies is not retroactively revocable); the relicense
  applies to 2.0.0 and every future release.

### Notes

- The HTTP relay **client** ships, but the relay **server** is a separate,
  forthcoming project — `project sync --remote-url` / `project clone
  --remote-url` are not usable until a compatible relay exists. The default
  file transport and all local features are unaffected.

## [1.1.0] — 2026-06-09 (unpublished — superseded by 2.0.0)

Additive, backward-compatible feature release. Every new capability is
optional and off by default — with nothing configured, behavior is
identical to 1.0.0 (file-based sync, FTS5 lexical search, no contradiction
pass). The on-disk event log layout and existing CLI surface are unchanged.

### Added

- **HTTP relay sync transport (P3-b-2).** An optional `http` sync transport
  lets machines that do not share a filesystem auto-sync through a relay.
  Client-side only (the relay server is a separate project); configured via
  `memorize project sync --remote-url <url> [--token <t>]` and
  `memorize project clone <id> --remote-url <url>`. No relay configured =
  the existing file transport, unchanged.
- **Semantic search (P3-c).** An optional OpenAI-compatible `/embeddings`
  endpoint (`MEMORIZE_EMBEDDINGS_ENDPOINT`/`_API_KEY`/`_MODEL`; works with a
  local Ollama, no key required) adds embedding similarity on top of FTS5.
  Embeddings are a best-effort auxiliary index filled at consolidation
  boundaries; search and startup injection use a hybrid (RRF) ranking.
  `memorize search --lexical` forces pure FTS. Unset = FTS5 only.
- **Semantic contradiction detection (P3-c).** When both an embedder and an
  LLM are configured, the consolidation boundary surfaces `decision`
  memories that assert incompatible facts: the more recent decision is kept
  as current truth (deterministic, replica-convergent), the older is
  non-destructively superseded, and a conflict is raised for the agent to
  resolve. Cross-session forks are tagged. Unconfigured = no-op.
- **`memorize uninstall claude|codex`.** The inverse of `install` — removes
  memorize's hook entries and integration blocks while preserving the user's
  other config. Idempotent; captured memory (events/projection) is left
  intact.

## [1.0.0] — 2026-05-06

First stable release. The 1.0 cut closes the rc.5..rc.12 alpha
stabilization series and establishes the data, lifecycle, and
attribution invariants the project is willing to support
indefinitely. No new features over rc.12 — this is a repackaging.

### What 1.0 commits to

- **Per-cwd multi-session.** Multiple agent sessions in the same
  directory at the same time are a first-class case. Each
  SessionStart claims a distinct task atomically (file lock); the
  picker hides heartbeat-stale sessions from view but never
  silently mutates their on-disk status.
- **"1 agent conversation = 1 memorize session" across resume.**
  Both Claude (`claude --resume`) and codex (`codex resume`)
  preserve their session UUID, and memorize stamps that UUID on
  the cwd pointer at SessionStart so the resume path reattaches
  to the same memorize session instead of minting a new one. The
  Model C lifecycle (rc.12) keeps the cwd pointer alive across
  SessionEnd by transitioning the session to `paused` rather
  than deleting the pointer; resume flips it back to `active`.
- **Single resolver for "which session am I?"** Every CLI command
  and hook handler that asks "which memorize session is calling
  me?" goes through `resolveSessionContext` (the SSoT, rc.8).
  The priority chain is the same everywhere: env
  (`MEMORIZE_SESSION_ID`) → agent-native env
  (`CODEX_THREAD_ID`, rc.11) → process-tree agent-pid →
  tty → opt-in most-recent. No code path rolls its own.
- **Heartbeat-driven liveness, explicit reap.** A pointer's
  `lastSeenAt` is bumped by every memorize CLI call; the picker
  filter and the reap sweep both consult it. The only mutator of
  session status is `memorize session reap`. Auto-reap on
  startSession was removed in the alpha series and is not coming
  back: long-lived role sessions need their pointer to survive
  unrelated session starts.
- **Append-only event log + projection rebuild.** Domain state
  changes go through events; projections are rebuilt from the log
  on every write. There is no in-place mutation of projected
  records. `session.paused` joins the existing `session.started`
  / `session.resumed` / `session.completed` / `session.abandoned`
  / `session.heartbeat` set.

### Known platform asymmetries (intentional, documented)

- **Codex has no SessionEnd hook.** Its registered hook surface is
  SessionStart / PreToolUse / PostToolUse / UserPromptSubmit /
  Stop. Codex sessions therefore skip the `paused` transition
  entirely — they stay `active` until heartbeat-stale, then the
  next reap sweep marks them `abandoned`. Picker hides them via
  heartbeat staleness in the meantime, so the asymmetry is
  invisible to attribution and to the picker. Listed here so an
  inspector who reads the projection isn't surprised that two
  agents leave different artifacts behind on a clean exit.
- **`memorize task handoff --help` is unconventional.** The flag
  parser treats `--help` as a value-bearing flag and errors
  rather than printing usage. Codex agents recover by trial; no
  data correctness impact. Tracked for a 1.0.x patch.

### Diagnostic surface

- `MEMORIZE_DEBUG=1` causes every labeled call to
  `resolveSessionContext` / `resolveByAgentSessionId` to emit one
  stderr line tagged `label=… via=… session=… task=… actor=…
  agentPid=… agentSession=… ppid=… walked=[…] pointerPids=[…]`.
  Off by default — zero overhead in normal operation. This was
  what made the rc.10 → rc.11 codex resolver hole diagnosable in
  one round of dogfood; keep it in for the next surprise.

### Tests

201 tests across 42 files, all green. The suite covers: resolver
priority chain (env / agent-env / agent-pid / tty / most-recent /
none), file-lock serialization (race regression for picker
deconfliction), Model C pause→resume cycle, agent-pid debug
emit, install/doctor/handoff/checkpoint paths, and the cumulative
β session-lifecycle redesign.

## [1.0.0-rc.12] — 2026-05-06

### Changed — session lifecycle: end is now pause-by-default (Model C)

The Claude SessionEnd hook used to mark the session `completed` and
unlink the cwd pointer. That broke `claude --resume` for the same
session: the resume's SessionStart fires with the same agent UUID,
but `resolveByAgentSessionId` walks cwd pointers — and the pointer
was gone. The resume path silently fell back to minting a new
memorize session, breaking the "1 agent conversation = 1 memorize
session" invariant the SessionStart resume detection was supposed
to preserve.

Lifecycle is now explicit:

- New status `paused` between `active` and `completed`/`abandoned`.
  `paused` keeps the cwd pointer and the projection record on
  disk; the picker treats `paused` exactly like `active` (still
  claims its task, still subject to heartbeat staleness).
- New event `session.paused` with its own projector case.
- New `pauseSession()` service function. SessionEnd hook now calls
  `pauseSession` instead of `endSession`. The pointer survives,
  resume reattaches via existing `resolveByAgentSessionId` →
  `resumeSession()` path, and the projector flips `paused` back
  to `active` on the `session.resumed` event.
- Reap sweep picks up paused-and-stale sessions on the same
  threshold as active-and-stale ones — `paused` is "agent went to
  bed", `abandoned` is "agent never came back". `endSession` is
  still in code for an eventual explicit `memorize session end`
  CLI but no hook calls it now.
- Codex has no SessionEnd event at all (its hook surface is
  SessionStart / PreToolUse / PostToolUse / UserPromptSubmit /
  Stop). Codex sessions therefore skip pause and rely on the same
  reap path, which is fine: `paused` and `active` are equivalent
  for picker and reap, so the asymmetry has no observable effect.

### Fixed — resume returns the previously-claimed task

The SessionStart resume path called `composeStartupContext` with
only `selfSessionId` set. The picker excluded the just-resumed
session from its own view and then returned whatever
unclaimed-or-other task happened to surface — not the task the
session previously claimed. Round-6 dry-fire reproduced this:
codex session resume returned the claude session's task in the
hook's `additionalContext`. `composeStartupContext` now accepts
an explicit `taskId` and the resume path passes the resumed
pointer's `taskId`; the explicit CLI `runResumeTask` already
worked this way (rc.9), so this brings the hook path to parity.

### Tests

- `tests/integration/claude-hook-lifecycle.test.ts` — two existing
  SessionEnd tests rewritten to assert pointer survival +
  `session.paused` + projection status `paused` (was: pointer
  unlinked + `session.completed`). One new end-to-end test pins
  the full pause→resume cycle: same memorize session id is
  preserved, status flips paused→active, no second pointer
  minted.
- `tests/integration/task-aware-hooks.test.ts` — same SessionEnd
  test rewrite.

### Tests count: 200 → 201

## [1.0.0-rc.11] — 2026-05-06

### Fixed — codex `task resume` returns the wrong task on macOS

Round-5 dogfood, with the rc.10 instrumentation: codex `task resume`
emitted `via=none walked=[1727,90450,90373,90372,415]
pointerPids=[…,99604]`. The walked ancestor chain bottomed out at
launchd before reaching codex's pid (99604), even though codex was
the agent that started the subprocess. The Claude/codex shell tool
worker subsystems detach their workers and the OS reparents them
to launchd, so a CLI subprocess walking up `process.ppid` never
encounters the agent root pid. The agent-pid path is structurally
broken on macOS for both agents — Claude was only working because
of the parallel `MEMORIZE_SESSION_ID` env injection via
`CLAUDE_ENV_FILE`. Codex had no equivalent injection, so it fell
all the way through to `none` and the picker returned the first
project todo.

`env | grep -i codex` inside a codex subprocess revealed
`CODEX_THREAD_ID=<codex session UUID>` propagates natively. We
already stamp that same UUID as `agentSessionId` on the cwd
pointer at SessionStart, so a one-line resolver path closes the
hole:

- New resolution path `agent-env`, slotted between our own `env`
  and the (now defensive) `agent-pid`. Reads `CODEX_THREAD_ID`,
  matches against `agentSessionId` on cwd pointers. Returns
  `none` on miss rather than silently picking an unrelated codex
  pointer — the priority chain stays exact.
- Belt-and-suspenders precedence: when both `MEMORIZE_SESSION_ID`
  and `CODEX_THREAD_ID` are set, our explicit injection still
  wins. The codex env path is the codex-only fallback for the
  case where our injection never happened.

Verified directly: `CODEX_THREAD_ID=<uuid> memorize task resume`
in the duo-pane sandbox now returns `via=agent-env session=…
task=task_moplj40r_oi7j35wh actor=codex` instead of `via=none`
+ first-todo. Round-6 dogfood will pin it inside a real codex
session.

### Added — diagnostic refinements

- Debug emit now includes `walked=[…]` (the ancestor pid chain
  the resolver actually walked) and `pointerPids=[…]` (the set
  of `agentPid` values stamped on cwd pointers in this cwd).
  These two fields are what made the macOS reparenting cause
  diagnosable in one line — keep them in for the next surprise.

### Tests

- 3 new cases in `tests/unit/session-context.test.ts` for
  `agent-env`: resolves codex pointer when `CODEX_THREAD_ID`
  matches; our `MEMORIZE_SESSION_ID` env wins when both are
  set; non-matching `CODEX_THREAD_ID` falls through to `none`
  (no silent wrong attribution to an unrelated codex pointer).

### Tests count: 197 → 200

## [1.0.0-rc.10] — 2026-05-06

### Added — diagnostic-only, no behavior change

- **`MEMORIZE_DEBUG=1` resolver instrumentation.** Round-4 dogfood found
  codex `task resume` returning the first project todo instead of the
  calling session's claimed task, while same-session `task handoff`
  attributed correctly. Both paths use `resolveSessionContext`, so the
  divergence had to be inside the resolver — but with no per-call-site
  visibility we couldn't tell which branch (env / agent-pid / tty /
  none) `task resume` actually hit. With `MEMORIZE_DEBUG=1` set, every
  resolver call from a labeled call site now emits one stderr line:

  ```
  [memorize-debug] resolve label=task-resume via=none session=- task=- actor=- agentPid=- agentSession=- ppid=12345
  ```

  Labels wired in: `task-resume`, `task-handoff`, `task-checkpoint`
  (CLI), `hook-session-start-resume`, `hook-post-compact`,
  `hook-session-end` (hooks). Unlabeled calls stay silent. Off when
  the env var is unset — no overhead in normal operation.

  Local smoke run from a non-session shell already reproduced the
  bug pattern: `via=none` → picker falls back to first todo
  (`task_mos7v3iw`, exactly the task codex was reporting). Round-5
  dogfood will surface whether codex's `task resume` subprocess hits
  the same branch (env propagation gap) or a different one (process
  tree depth, lazy SessionStart timing).

### Tests

- `tests/unit/session-context.test.ts` — 4 new cases for the debug
  emit: silent when `MEMORIZE_DEBUG` unset, silent when no label,
  one tagged line when both set, `via=none` for misses so we can
  tell "no pointer" from "wrong pointer".

### Tests count: 193 → 197

## [1.0.0-rc.9] — 2026-05-05

### Fixed (rc.7 round-2 dogfood follow-ups, plus rc.8 round-3 finding)

- **Picker race — atomic SessionStart claim.** Two SessionStart hooks
  firing within ms of each other in the same project (round-2 dogfood:
  32ms gap) both saw the same active set in their picker view, so
  both newly-started sessions claimed the same task. The pick-then-
  claim window is now serialized per project via a tiny file lock
  (`<project_root>/locks/session-start.lock`, O_EXCL create with
  retry-and-stale-reclaim). Resume path skips the lock — only fresh
  claims need it.
- **`memorize task resume` is session-aware.** Round-3 codex session
  noticed `task resume` showed the project's first active task
  instead of the calling session's claimed task — the same Gap A
  pattern handoff/checkpoint had before rc.7. Now uses
  `resolveSessionContext` to thread the calling session's `taskId`
  and `selfSessionId` into `loadStartContext`.

### Added

- **`storage/file-lock.ts` — `withFileLock(lockDir, name, body, opts)`.**
  Generic per-project advisory lock primitive built on O_EXCL create.
  Holds for the duration of `body`, removes on completion (even on
  throw), reclaims stale locks past `holdTimeoutMs` (default 5s) so
  a crashed holder can't deadlock future entries.

### Tests

- `tests/unit/file-lock.test.ts` — 4 cases pinning the lock contract:
  body runs and lock is removed; lock is removed on throw; concurrent
  acquirers serialize (B's enter follows A's exit); stale lock is
  force-reclaimed past `holdTimeoutMs`.
- `tests/integration/picker-deconflict.test.ts` — new race regression
  test fires 4 SessionStart hooks in parallel and pins that each
  ends up with a distinct claimed task. Without the lock this fails
  repeatably.

### Tests count: 188 → 193

## [1.0.0-rc.8] — 2026-05-05

### ADR-1: single source of truth for session resolution

The rc.4 → rc.7 series fixed Gap A in three different code paths,
each with its own slightly different env → tty → most-recent fallback
chain. The 4-session round-2 dogfood showed that per-path duplication
hadn't actually closed the hole — codex CLI subprocesses still
attributed to `actor: user` against the wrong `taskId` because the
CLI command's chain lacked an agent-pid hop. The pattern was on its
way to becoming spaghetti: every new agent quirk meant another
fallback in another caller.

- **New `services/session-context.ts` is the only resolver of "which
  session am I?".** Exposes `resolveSessionContext(cwd, { allowMostRecent })`
  and `resolveByAgentSessionId(cwd, agentId)`. Returns
  `ResolvedSessionContext` with `sessionId`, `taskId`, `actor`,
  `projectId`, `agentSessionId`, `agentPid`, and a `resolvedVia` field
  (`'env' | 'agent-pid' | 'tty' | 'most-recent' | 'none'`) so the
  resolution path is observable when an attribution looks wrong.
- **New `storage/cwd-session-store.ts`** owns the `CwdSessionPointer`
  type and all pointer file I/O (read / write / list / delete /
  legacy migration). Both `services/session-service` (lifecycle) and
  `services/session-context` (resolution) read through this single
  storage module — no more file paths scattered across services.
- **All callers migrated.** `runHandoffTask`, `runCheckpointTask`,
  `handlePostCompact`, `handleSessionEnd`, `bumpHeartbeat`,
  `endSession`, `getCurrentSessionId`, the wrappers — every
  identity-resolving call now goes through the SSoT.

### Fixed (rc.7 dogfood — codex CLI env propagation hole)

The new resolver adds an **agent-pid match** path the per-caller
chains were missing. SessionStart already stamped the host agent's
pid on the cwd pointer (rc.6); rc.8 walks up `process.ppid` in the
CLI subprocess and looks for a pointer whose `agentPid` is in that
chain. This is the only reliable identity path for codex (codex has
no `CLAUDE_ENV_FILE` equivalent, so `MEMORIZE_SESSION_ID` never
reaches its Bash subprocesses, so env-fallback always missed).
Priority: `env` (fast, exact) → `agent-pid` (slower, exact, the new
hop) → `tty` (best-effort) → opt-in `most-recent`.

The rc.7 fix to `runHandoffTask` / `runCheckpointTask` stays in
place — those handlers now ask `resolveSessionContext` directly
instead of running their own short fallback chain, so the agent-pid
hop reaches them automatically.

### Tests

- New `tests/unit/session-context.test.ts` — 6 cases pinning each
  resolution path: `none` when no pointers, `env` exact match,
  `agent-pid` ancestor walk match (planted with `process.ppid`),
  env-wins-over-agent-pid priority, default refusal of most-recent
  fallback, opt-in most-recent fallback.
- All 182 prior tests still pass — refactor was behavior-preserving
  for the existing surface; the codex hole closes via the new
  agent-pid path.

### Removed

- `findCwdSessionByAgentId` (was a private helper in session-service)
  superseded by `resolveByAgentSessionId` from session-context.
- The duplicated env → tty → most-recent fallback in
  `findCwdSession`, `runHandoffTask`, `runCheckpointTask`,
  `handlePostCompact`. All now delegate to `resolveSessionContext`.

## [1.0.0-rc.7] — 2026-05-05

### Fixed (rc.6 dogfood — Gap A leak at the CLI surface)

The first 4-session mixed dogfood (2 Claude + 2 Codex in one cwd)
exposed that the rc.4 Gap A fix only landed inside the hook handlers
(`PostCompact`, etc.) — `memorize task handoff` and `memorize task
checkpoint` invoked from inside an agent's Bash subprocess kept
falling back to `project.activeTaskIds[0]` and `ACTOR_USER`. Result:
both codex sessions' handoffs attached to whichever task happened to
be first in the project's active list (always the same `task_moplj3xs`
in the dogfood fixture), and `fromActor` was attributed to "user"
instead of "codex". The third session out of four was the only one
that came out clean — and only because it manually probed CLI flags
and ended up passing `--task` and `--from` explicitly.

- **`runHandoffTask` now resolves `taskId` via the session-aware
  fallback chain.** `--task` arg → `getCurrentSessionTaskId(cwd)` →
  `project.activeTaskIds[0]`. The middle hop is the fix.
- **`runHandoffTask` now resolves `fromActor` from the session
  pointer's `startedBy` when `--from` is omitted.** Falls back to
  `ACTOR_USER` only when no session is resolvable in the cwd.
- **`runCheckpointTask` gets the same `taskId` chain** for symmetry —
  same Gap A pattern, same fix.
- **New helper `getCurrentSessionActor(cwd)`** in `session-service.ts`
  pairs with the existing `getCurrentSessionTaskId`.

### Tests

- `tests/integration/services-and-cli.test.ts`: two new regressions —
  one starts a session that claims a non-first task and asserts the
  CLI handoff lands on the claimed task with `fromActor: 'codex'`;
  the other does the same for checkpoint via `latestCheckpointId`
  inspection.
- Test infra: `mkdtemp` results are now `realpath`-ed before use, so
  the macOS `/var/folders` → `/private/var/folders` symlink mismatch
  between the test process and spawned CLI subprocesses no longer
  breaks bindings lookups.

## [1.0.0-rc.6] — 2026-05-05

### Picker-aware session lifecycle (β step 1+2, dogfood-verified)

The rc.5 β redesign moved lifecycle off the per-turn `Stop` hook onto
`SessionEnd` + an auto-reap inside `startSession`. Dogfood feedback:
users who routinely `claude --resume` a long-lived role session would
see their pointer wiped the next time an unrelated session started in
the same cwd, because auto-reap couldn't tell "abandoned" from
"intentionally idle." rc.6 separates the two concerns.

### Changed (no breaking surface, but the contract has shifted)

- **Picker view filters stale sessions without mutating their status.**
  `readActiveSessions` now hides sessions whose `lastSeenAt` is older
  than `MEMORIZE_STALE_SESSION_MS` (default 30 min) from the
  startup-context picker. Their on-disk status stays `active` and the
  cwd pointer stays where it is; only the picker view changes. A
  long-idle role session is invisible to other agents but instantly
  reattachable on resume.
- **`startSession` no longer auto-reaps prior pointers in the same
  cwd.** Status mutation (`active` → `abandoned`) is now reachable
  only through the explicit `memorize session reap [--force]` command.
  Three sequential `startSession` calls with `MEMORIZE_STALE_SESSION_MS=0`
  leave all three pointers on disk — locked into the test suite as a
  contract.
- **Resume detection on SessionStart.** When the SessionStart hook
  payload carries an `agent session_id` (Claude UUID, Codex session
  UUID) that already matches a cwd pointer's stored `agentSessionId`,
  the handler reattaches to that memorize session instead of minting
  a new one. New event type `session.resumed` records the reattach
  on the projection without a status transition.
- **`agentPid` captured on SessionStart.** The hook walks up its
  parent process tree (`ps -o pid,ppid,comm`) looking for a `claude`
  or `codex` ancestor, then stamps the resulting pid on the cwd
  pointer. Resume rewrites it with the new agent process pid.

### Verified end-to-end

- **`claude --resume <uuid>`** — Claude preserves its session UUID
  across resume; resume detection reattaches to the same memorize
  session. Locked in as a regression in
  `tests/integration/claude-hook-lifecycle.test.ts` (one
  `session.started`, ≥1 `session.resumed`, single pointer survives).
- **`codex resume`** — verified by dogfood in the duo-pane fixture.
  Codex preserves its agent session UUID across resume too, so the
  same code path works for both agents. Caveat: codex fires
  SessionStart **lazily** — not on the `codex resume` command itself,
  but on the first user turn after the resumed session starts. By
  the time anything observable happens, our hook has already run; the
  laziness is invisible at the memorize layer.
- **Picker stale-hide** — locked in as
  `tests/integration/picker-deconflict.test.ts`: a back-dated session
  disappears from `loadStartContext.otherActiveTasks` while its
  on-disk record still reads `status: "active"`.

### Tests

- 180 → 184 (added: resume reuse, picker stale-hide, resumeSession
  unit coverage, process-tree liveness/walk).

## [1.0.0-rc.5] — 2026-05-03

### Fixed (β verification follow-ups)

- **SessionEnd hook env propagation** — verified empirically that
  Claude does NOT pass `MEMORIZE_SESSION_ID` into the SessionEnd hook
  subprocess (despite SessionStart's exported env reaching every other
  Bash/tool subprocess). Without env, `endSession` couldn't find its
  cwd pointer and silently returned, so `session.completed` never
  fired and pointers leaked on every real `/exit` or `Ctrl+C`. Fix:
  the SessionStart hook now stamps the agent's own session id (Claude
  UUID, etc.) on the cwd pointer as `agentSessionId`, and SessionEnd
  resolves the calling memorize session via `payload.session_id` →
  `agentSessionId` lookup. Env/tty fall back as a safety net.
- **Bare `memorize` hook command when on PATH** — Claude doesn't wait
  for SessionEnd to finish before exiting; the npx wrapper barely
  loaded node before getting reaped. Install now uses bare `memorize
  hook ...` when memorize is on PATH (launches in milliseconds) and
  falls back to `npx ...` only when it isn't. Override via
  `MEMORIZE_HOOK_COMMAND_FORM=npx|bare`.

### Session lifecycle redesign (β track). The rc.0..rc.4 line treated
Claude's `Stop` hook as session-end; in fact `Stop` fires per assistant
turn, which produced one bogus auto-handoff per turn and (in rc.3+)
caused per-turn `session.completed` event attempts. Verified by data:
the duo-pane dogfood log shows 4 handoffs in 49 seconds across a single
session. Codex has the same per-turn `Stop` semantics and no
session-end hook of any kind.

This release moves session lifecycle off per-turn hooks entirely.

### Changed (breaking for anyone who depended on per-turn auto-handoffs)

- **`Stop` hook is now a no-op.** Both `memorize hook claude Stop` and
  `memorize hook codex Stop` return `{}`. They no longer create
  handoffs and no longer touch the session pointer. Pre-β installs
  that still register Stop continue to work — the no-op response
  satisfies the schema. `memorize install claude` and `memorize
  install codex` strip memorize's Stop registration on re-run while
  preserving any user-added Stop entries for other tools.
- **Handoffs are agent-initiated.** Agents must call `memorize
  handoff create ...` explicitly when they actually want to summarize
  work and pass control. Auto-creation per turn is gone.
- **Claude `SessionEnd` hook is registered on install.** It fires on
  every termination path Claude exposes (clean `/exit`, `Ctrl+C`,
  terminal close — see `reason` field) and writes a clean
  `session.completed` plus unlinks the cwd pointer.
- **Codex lifecycle owned entirely by `reapStaleSessions`.** Codex
  has no `SessionEnd` / `Shutdown` hook (verified against
  developers.openai.com/codex/hooks 2026-05). The next codex
  `SessionStart` in the same cwd reaps prior abandoned pointers; the
  new `memorize session reap` command lets users force a sweep.

### Added

- **`session.abandoned` event + Session status.** Distinct from
  `session.completed`: a session that ended without a clean shutdown
  (Ctrl+C, crash, codex exit, heartbeat timeout). The picker treats
  abandoned the same as completed (not active) so the underlying
  task is fair game for the next agent.
- **`reapStaleSessions(cwd, { force? })`.** Sweeps cwd pointers past
  the heartbeat staleness threshold (`MEMORIZE_STALE_SESSION_MS`,
  default 30 min). Triggered automatically by `startSession` and
  exposed via `memorize session reap`.
- **`memorize session reap [--force]` CLI command.**

### Fixed (carried from the partial rc.4 work)

- **Gap B — `CLAUDE_ENV_FILE` propagation.** memorize was writing
  `KEY="value"` lines to a `.sh` script Claude sources; without
  `export` the assignments stayed shell-local. Now writes
  `export KEY="value"`. Verifiable via `env | grep MEMORIZE`.
- **Gap A — checkpoint task attribution.** `PostCompact` resolved
  the active task via `project.activeTaskIds[0]`, picking an
  arbitrary other agent's work whenever the calling session was on
  something else. Now reads the task this session claimed at
  `SessionStart` (via `getCurrentSessionTaskId`).

### Documented

- **Gap C — Codex sandbox + memorize home.** Codex's default
  workspace-write sandbox blocks writes to `~/.memorize/`. Workaround:
  allowlist `~/.memorize` or set `MEMORIZE_ROOT` inside the sandbox.
- **Lifecycle ownership.** `AGENT_GUIDE.md` now documents the new
  `SessionStart` → heartbeat → `SessionEnd` / reap flow and the
  agent-initiated handoff contract.

### Skipped

The `1.0.0-rc.4` cut never shipped — it was rolled forward into rc.5
when the Stop=session-end design flaw was discovered during rc.4
verification. See `tests/integration/task-aware-hooks.test.ts` and
`AGENT_GUIDE.md` for the post-β contract.

## [1.0.0-rc.3] — 2026-05-03

Two bugs surfaced by the rc.2 dogfood against the duo-pane test
project. Both would have shipped to 1.0 had we not actually run four
parallel agents.

### Fixed

- **Auto-picker now deconflicts against active sessions.** The
  `loadStartContext` task picker used to return `candidateTasks[0]` as
  a final fallback, with the result that four sessions started
  90 seconds apart were all assigned the same first task. Now the
  picker filters out tasks already claimed by other active sessions
  (excluding `selfSessionId`) before falling back to a deterministic
  pick. The `otherActiveTasks` list is no longer purely informational —
  the picker itself uses the same data.
- **`bumpHeartbeat` and `endSession` no longer guess.** The rc.2
  most-recent-active fallback was attributing telemetry to the wrong
  session whenever neither env propagation nor tty matching worked
  (the common case for Claude's tool subprocesses and for Codex
  entirely). The dogfood found Claude's Stop hook killing a codex
  session via this path. Telemetry callers now silently no-op when
  they cannot reliably identify the calling session — better a missed
  heartbeat than a wrong attribution.
- **`endSession` accepts an explicit `sessionId` option.** Stop hook
  payloads carry the agent's `session_id`; the hook handler now
  forwards it to `endSession` so attribution is correct even when env
  and tty disambiguation both fail.

### Notes

- `getCurrentSessionId` keeps the most-recent-active fallback (opt-in
  via `findCwdSession` flag) because it is the ambient-CLI entry point
  that must always return a sessionId. Telemetry/lifecycle callers do
  not opt in.

## [1.0.0-rc.2] — 2026-05-03

Architectural fix surfaced while planning Sprint 3-4 dogfooding. The
"one cwd = one session" assumption baked into the rc.0/rc.1 session
pointer broke the common case of running two Claude (or Claude + Codex)
sessions in the same project directory — heartbeats from the second
session would clobber the first's pointer and the assignment-model
freshness label would lie.

### Changed

- **Session pointer layout.** `<cwd>/.memorize/current-session.json`
  (single pointer) → `<cwd>/.memorize/sessions/<sessionId>.json`
  (one file per active session). Each pointer stores the starting tty
  rdev so subprocesses can attribute themselves back to the right
  session.
- **Session resolution priority** for `bumpHeartbeat`, `endSession`,
  `getCurrentSessionId`: `MEMORIZE_SESSION_ID` env (Claude path) → tty
  match (Codex path) → most-recently-started active pointer (ambient
  CLI fallback).

### Migration

- A legacy `current-session.json` is migrated automatically the first
  time any session-service entry point runs in that cwd; the original
  file is then removed. No user action required.

### Why this matters for 1.0

The Sprint 2 lock-free assignment model only works if heartbeats reach
the right session. Without this fix, two parallel Claude sessions in
the same project would each see the other as `stale (likely abandoned)`
within minutes and start picking up each other's tasks — exactly the
failure mode dogfooding is meant to validate against.

## [1.0.0-rc.1] — 2026-05-03

Pre-dogfooding cleanup. Surfaced while preparing the duo-pane test
project: legacy memorize bootstrap blocks were being left in `AGENTS.md`
across `install codex` runs.

### Fixed

- `install codex` now also strips legacy `<!-- memorize:bootstrap -->`
  blocks from `AGENTS.md` (in addition to `AGENTS.override.md`). The
  `AGENTS.md` file is user-owned, so the strip never deletes it even if
  the file ends up empty — that decision belongs to the user.

## [1.0.0-rc.0] — 2026-05-03

First release candidate. The 1.0 promise: the on-disk layout described in
the "Storage" section of the inventory and the CLI command surface listed
under `## Day-to-day commands` in the README will not break compatibility
within the 1.x line.

### Added

- **Lock-free informational assignment model.** `Session` entity is now
  fully wired: `session.started` / `session.heartbeat` / `session.completed`
  events are emitted, projector reduces them into a sessions map, and a
  CLI middleware pumps a heartbeat after every non-session-managing command.
- **Other active tasks in the startup payload.** `task resume` (and the
  hook-rendered SessionStart context) now lists tasks held by other live
  sessions with a freshness label (`active 5m ago`, `stale ~2h ago`,
  `stale (likely abandoned)`) so a parallel agent can pick a different
  task and avoid duplicate work.
- **PostCompact summary surfacing.** When a Claude session is resumed
  after a context compact, the latest `Checkpoint.summary` for the
  picked-up task is rendered into the new session's startup payload so
  continuity is preserved.
- **Renderer character budget.** Startup payloads have a soft cap
  (default 8000 chars, ~2000 tokens) with strict-priority block ordering
  (project > task > handoff > checkpoint > conflicts > other-tasks >
  topics). Overflow drops the lowest-priority blocks and emits a budget
  notice listing what was omitted.
- **Sync golden test.** `tests/golden/sync-roundtrip-golden.test.ts`
  pins which event types cross the wire (session events DO, sync state
  does NOT) — any future filter change is a breaking change and must
  bump major.
- **Quickstart demo.** `examples/quickstart.sh` is a self-contained
  30-second sequence (project setup → task create → task resume →
  checkpoint) intended for asciinema/GIF recording. An integration test
  locks the script's milestones so the public asset cannot rot silently.

### Changed

- `MEMORY.md`-style task assignment is no longer enforced — the design is
  intentionally informational. Memorize records who is on what; agents
  decide whether to defer.
- Renderer blocks are now built with explicit priorities and an optional
  `{ budget }` argument so tests can drive drop scenarios without padding
  payloads to many kilobytes.

### Removed

- `do "<sentence>"` experimental NL intent router. Agents call task /
  handoff commands directly; the indirection was not earning its keep.
- `launch claude|codex` legacy wrapper. `install <agent>` is the standard
  entry point now.
- `workstream.updated`, `checklist.item.upserted` events and the
  `ChecklistItem` entity (declared but never reduced).

### Experimental (NOT covered by the 1.0 compatibility promise)

- `memorize project sync [--push|--pull|--bind|--remote-path]`. The file
  transport is functional and roundtrip-tested but real cross-machine
  dogfooding is post-1.0. Treat its CLI flags and on-disk wire format
  as subject to breaking change in a 1.x minor release.
- `sync.state.updated` event type (local bookkeeping; intentionally
  filtered from sync push payloads).

## [0.2.0-alpha.0] — 2026-04-21

Last alpha cut before the 1.0 stabilization sprints.

- Codex hook integration (`install codex` writes to global
  `~/.codex/hooks.json`; `doctor` verifies install).
- Doctor `fix` text for missing `project setup` corrected.
- Codex install now strips legacy blocks instead of writing new ones,
  preserves hook order (memorize first), and is idempotent.
- Codex hooks are now the documented integration contract.
