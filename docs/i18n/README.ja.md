# Memorize — AIコーディングエージェントのための共有メモリ

[![npm](https://img.shields.io/npm/v/%40shakystar%2Fmemorize)](https://www.npmjs.com/package/@shakystar/memorize)
[![CI](https://github.com/shakystar/memorize/actions/workflows/ci.yml/badge.svg)](https://github.com/shakystar/memorize/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](../../LICENSE)

[English](../../README.md) | [한국어](./README.ko.md) | **日本語** | [简体中文](./README.zh-CN.md) | [Español](./README.es.md)

<p align="center">
  <img src="../../.github/assets/social-preview.png" alt="memorize — shared memory for AI coding agents" width="720">
</p>


> あなたと Claude Code、Codex がひとつの永続的なプロジェクトの脳を共有する —
> ローカルファースト、イベントソーシング、生物学的な記憶の仕組みに倣った設計。

エージェントはセッションが終わるとすべてを忘れます。Memorize はエージェントの
作業を観察し、重要だったことを長期記憶へ蒸留し、次のセッション開始時に最適な
記憶を再注入します — プロジェクトの**すべての**エージェントへ、マシンをまたいで、
サーバーも API キーも不要で。

## なぜ必要か

- **Claude のセッションが終わるとコンテキストも消える。** 次のセッションでは、
  何をしていたか、何を決めたか、どこで止まったかを説明し直すことになります。
- **Claude から Codex に切り替えるとゼロからやり直し。** エージェントごとに
  メモリのサイロがあり、互いのノートは見えません。
- **マシンが2台なら、脳も半分ずつ2つ。** デスクトップのコンテキストは
  ノートPCについてきません。

## 仕組み

1. **キャプチャ** — エージェントの作業中、フックが安価なルールベースの観測
   (ファイル編集、意思決定、タスク遷移)を記録します。LLM なし、遅延なし。
2. **統合(consolidation)** — セッション境界ごとにバックグラウンドプロセスが
   観測を長期記憶(決定・根拠・進捗)へ蒸留し、重要度スコアを付けます。
   抽出はログイン済みの `claude` / `codex` CLI 経由で動きます — API キー不要。
   OpenAI 互換エンドポイントやルールベースのフォールバックにも対応。
3. **検索(retrieval)** — 次のセッション開始時、記憶は重要度 × 新しさ
   (半減期14日、再利用で強化)× 現在のタスクとの関連度でコンテキスト予算を
   競います。忘却は検索時のみ。何も削除されません。
4. **共有** — 並行セッションは互いの作業をリアルタイムに見ます(ファイル
   競合の警告つき)。同じイベントログがマシン間で同期し、決定論的に収束。
   記憶同士の矛盾は自動検出・解決されます — 新しい方が勝ち、古い方は
   復元可能なまま残ります。

より深い話 — 2層 CLS メモリ設計、ウォーターマークによる冪等な統合、
検索時忘却、dogfooding データでスキーマを進化させる lifecycle-evidence
プログラム — は **[ARCHITECTURE.md](../ARCHITECTURE.md)**(英語)にあります。

### セッション開始時にエージェントが見るもの

```text
# Memorize context

Ground rule: memorize is the single source of truth for project state …

Project: Realtime whiteboard MVP
Task: Fix cursor jitter on remote drag
Latest handoff: from codex — "Repro narrowed to the throttle in
  useRemoteCursor; failing test added in cursor-sync.test.ts"
Consolidated memories:
- [decision/s9] WebSocket transport chosen over WebRTC for v1 — simpler
  infra, revisit only if >200ms RTT becomes common
- [rationale/s7] Cursor positions are sent unthrottled on purpose; the
  jitter came from double-throttling, not bandwidth
- [progress/s5] LAN sync verified; jitter reproduces only above 80ms RTT
Recent work signals (prior session tail):
- [write-tool/Edit] src/hooks/useRemoteCursor.ts
- [decision-keyword/Bash] git commit -m "remove inner throttle"
```

説明し直す必要はありません。次のエージェントは — どのエージェントでも、
どのマシンでも — 正確にここから引き継ぎます。

## インストール

方法は2つ。**ほとんどの人は1つ目で十分です** — memorize は AI アシスタントが
プロジェクトごとにインストールするよう設計されています。

### 推奨 — AI にセットアップを任せる

Claude Code か Codex のセッションにプロンプトを1行送るだけ:

> Set up memorize in this project. Follow the instructions at
> https://github.com/shakystar/memorize/blob/main/guides/AI_SETUP.md

アシスタントがパッケージを追加し、ディレクトリをバインドし、適切な
エージェントフックをインストールし、既存のコンテキスト(自身のセッション
メモリ、あなたの設計ドキュメント)の memorize への吸収を提案し、
インストールを検証します。あとは普段どおり `claude` / `codex` を
使うだけ — セッション開始時にコンテキストが自動注入されます。

いつでも確認できます:

```sh
npx @shakystar/memorize doctor
```

(npx では必ずスコープ付きの名前を — npm のスコープなし `memorize` は
無関係なパッケージです。)

### 手動 — 自分で PATH に置く

<details>
<summary>ワンライナーインストール(グローバルバイナリ + <code>memorize setup</code>)</summary>

```sh
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/shakystar/memorize/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/shakystar/memorize/main/scripts/install.ps1 | iex
```

グローバルバイナリをインストールした後 `memorize setup` が実行され、
Claude Code と Codex を検出します。Codex 統合はその場でグローバルに
配線され、Claude のフックはプロジェクト単位なので、使いたい各プロジェクト
内で `memorize install claude` を実行するよう案内されます。

Node.js >= 22 が必要です。インストーラが確認し、なければ入手先を
案内します。

</details>

## 作業ディレクトリ

- memorize コマンドはプロジェクト内のどこからでも実行できます —
  カレントディレクトリから上へ辿り、最も近いバインド済みプロジェクトを
  見つけます(git と同じ挙動)。
- プロジェクトの `.memorize/` にはプロジェクト単位のランタイム状態が
  入ります。**`.gitignore` に `.memorize/` を追加してください**;
  なければ `doctor` が警告します。
- 永続イベントログはデフォルトで `~/.memorize/` に保存されます
  (`MEMORIZE_ROOT` で変更可)。

## 日常のコマンド

ほとんどは AI が代行します。人間が使いそうなもの:

```sh
memorize doctor            # プロジェクト + 統合状態の診断
memorize project show      # バインド済みプロジェクトの要約 (JSON)
memorize task list         # タスク一覧 (--status でフィルタ)
memorize task resume       # 現在のタスクの開始コンテキストをロード
memorize task handoff ...  # 次のエージェントへのハンドオフを記録
memorize consolidate       # 記憶統合の境界を今すぐ1回実行
```

`memorize` 単体で使い方の概要が出ます。その他すべてのコマンド(setup、
install、memory import、hook、projection rebuild、sync など)は
[AGENT_GUIDE.md](../../AGENT_GUIDE.md) に文書化されています — AI が詳細を
必要とするときに読むファイルです。

## トラブルシューティング

- インストールが途中でエラーになった — エラー出力全体を Claude/Codex の
  セッションに貼り、[AI_SETUP.md](../../guides/AI_SETUP.md) のリンクを
  添えてください。"Recovering a failed install" セクションが、よくある
  原因(Node バージョン、npm グローバル権限、PATH、WSL の競合)を
  エージェントに順に確認させます。エージェントがない場合は
  **Install failure** テンプレートで issue を立ててください。

- Claude セッションに memorize コンテキストが出ない — `memorize doctor`
  を実行し、失敗したチェックの `fix:` に従ってください。たいてい
  `memorize install claude` の再実行で直ります。
- インストールしたのに Codex が何も記録しない — codex は外部ツールが
  書いたフックを、対話セッションで一度承認するまで実行しません。
  `doctor` がこの状態を検出して知らせます。
- タスクを作ったのに一覧が空 — `memorize project show` でプロジェクト id
  が一致するか確認してください。別のバインド済みプロジェクトの中に
  いる可能性があります。
- プロジェクトから完全に削除する:
  - `memorize uninstall claude` / `memorize uninstall codex` —
    memorize のフックと ground-rule ブロックを削除し、他のフック/設定は
    保持します。冪等。キャプチャ済みの記憶はそのまま残ります。
  - プロジェクトの `.memorize/` を削除 — プロジェクト単位のランタイム
    状態を除去
  - 任意で `rm -rf ~/.memorize` — 全プロジェクトの永続イベントログを
    削除。キャプチャ済みの記憶を消す唯一のステップです。

## AI アシスタントの方へ

ユーザーに memorize のセットアップを頼まれたら
[guides/AI_SETUP.md](../../guides/AI_SETUP.md) に従ってください — 冪等な
セットアップ手順、既存コンテキストの吸収フロー、そして ground rule
(memorize が唯一の真実の源; その状態を自分のメモリに複製しないこと)が
書かれています。コマンドの詳細は [AGENT_GUIDE.md](../../AGENT_GUIDE.md) へ。

## ステータス

Memorize は `2.x` ライン(2.0.0 から AGPL-3.0-or-later)です。
互換性の約束は以下をカバーします:

- ディスク上のイベントログのレイアウトと、プロジェクト単位の
  `.memorize/` ディレクトリの形
- 上に挙げた日常 CLI の表面
- `install claude` / `install codex` が書き込むフック契約

メジャーライン内ではこれらを壊しません。イベントログはバージョン管理され、
プロジェクションは再生成可能なので、メジャーバージョン内のアップグレードに
手動のデータ移行は不要です。

**実験的**(マイナーリリースで変更の可能性あり):

- `memorize project sync` — ファイル転送は動作し、ラウンドトリップ
  テスト済み。HTTP リレークライアントは同梱されていますが、別途リレー
  サーバー(準備中)が必要です。
- 統合記憶の観測専用 lifecycle-evidence フィールドと
  `consolidate --report` の形式 — 分類体系の決定後に変わり得る計測です。

リリース履歴は [CHANGELOG.md](../../CHANGELOG.md) へ。

## コミュニティ

Issue と Discussion は誰でも歓迎です — バグ報告、設計議論、
「どうやるの?」という質問、すべてどうぞ:

- **[Issues](https://github.com/shakystar/memorize/issues)** — バグと
  具体的な機能要望
- **[Discussions](https://github.com/shakystar/memorize/discussions)** —
  設計の方向性やオープンなアイデア(記憶分類体系の議論はここで)

開発ワークフローは [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) へ。

## ライセンス

AGPL-3.0-or-later。[LICENSE](../../LICENSE) を参照。
