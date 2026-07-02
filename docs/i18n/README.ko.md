<p align="center">
  <img src="https://raw.githubusercontent.com/shakystar/memorize/main/.github/assets/social-preview.png" alt="memorize: AI 코딩 에이전트를 위한 공유 기억" width="720">
</p>

# Memorize: AI 코딩 에이전트를 위한 공유 기억

[![npm](https://img.shields.io/npm/v/%40shakystar%2Fmemorize)](https://www.npmjs.com/package/@shakystar/memorize)
[![CI](https://github.com/shakystar/memorize/actions/workflows/ci.yml/badge.svg)](https://github.com/shakystar/memorize/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](../../LICENSE)

[English](../../README.md) | **한국어**

> 여러분과 Claude Code, Codex, 여러 머신이 함께 쓰는 지속적인 프로젝트 두뇌입니다.

에이전트는 세션이 끝나면 맥락을 잃습니다. 무엇을 하던 중이었는지, 무엇을 왜 결정했는지, 어디서 멈췄는지를 잊습니다. Memorize는 작업 중 필요한 신호를 기록하고, 세션 경계에서 장기 기억으로 정리하고, 다음 세션이 시작될 때 알맞은 맥락을 주입합니다.

Memorize는 local-first입니다. 프로젝트 기억과 개인 기억은 내 머신에 저장되고 오프라인에서도 동작합니다. 여러 머신이나 여러 사람이 필요할 때는 선택 사항인 Hub가 동기화, 워크스페이스 정체성, 초대, 멤버십을 담당합니다. 세션 시작 경로는 네트워크를 기다리지 않습니다.

## 30초 설치

Memorize는 AI 어시스턴트가 프로젝트마다 설치하도록 설계되어 있습니다. Claude Code나 Codex 세션에 다음 한 줄을 보내면 됩니다.

> 다음 안내를 따라서 이 프로젝트에 memorize를 설치해 줘: https://github.com/shakystar/memorize/blob/main/guides/AI_SETUP.md

어시스턴트가 패키지를 추가하고, 현재 디렉터리를 프로젝트에 연결하고, 맞는 훅을 설치하고, 기존 프로젝트 맥락을 흡수할지 확인한 뒤 설치를 검증합니다. 그 다음부터는 평소처럼 `claude`나 `codex`를 사용하면 됩니다. 세션이 열릴 때 맥락이 자동으로 들어옵니다.

확인은 언제든 가능합니다.

```sh
npx @shakystar/memorize doctor
```

npx로는 반드시 스코프가 붙은 이름을 사용하십시오. 스코프 없는 `memorize`는 전혀 다른 npm 패키지입니다. 직접 PATH에 올리고 싶다면 [AI_SETUP.md](../../guides/AI_SETUP.md)에 수동 설치 방법이 있습니다. Node.js 22 이상이 필요합니다.

## 세션 시작 시 에이전트가 보는 것

```text
# Memorize context

Ground rule: memorize is the single source of truth for project state.
Project: Realtime whiteboard MVP
Task: Fix cursor jitter on remote drag
Latest handoff: from codex. "Repro narrowed to the throttle in
  useRemoteCursor; failing test added in cursor-sync.test.ts"
Consolidated memories:
- [decision/s9] WebSocket transport chosen over WebRTC for v1. Simpler
  infra; revisit only if >200ms RTT becomes common
- [rationale/s7] Cursor positions are sent unthrottled on purpose; the
  jitter came from double-throttling, not bandwidth
- [progress/s5] LAN sync verified; jitter reproduces only above 80ms RTT
Recent work signals:
- [write-tool/Edit] src/hooks/useRemoteCursor.ts
- [decision-keyword/Bash] git commit -m "remove inner throttle"
```

다시 설명할 필요가 없습니다. 다음 에이전트는 기록된 프로젝트 상태에서 이어받을 수 있습니다.

## 실사용 증거

아래 수치는 3일 동안 사람 손을 대지 않고 dogfooding한 결과입니다.

- **포착한 관찰 667개 중 654개를 기억으로 전환했습니다.** 전환율은 98%입니다.
- **기억 117개가 여러 세션에 407번 주입됐습니다.** 커밋 해시와 필드 이름처럼 자주 필요한 항목은 각각 19~21번 나타났습니다.
- **낡은 사실 29건이 최신 사실로 교체됐습니다.** 기억은 생애 동안 정리됩니다.
- **추가 비용은 코딩 토큰의 약 0.25%입니다.** 보수적으로 잡아도 1.8% 안쪽입니다.
- **포착, 통합, 교체, 주입이 사람 개입 없이 실행됩니다.**
- **병렬 세션이 같은 파일을 건드리면 작업 중 경고가 뜹니다.**

### Retrieval 벤치마크

실사용 외에 공개 500문항 장기기억 벤치마크 [LongMemEval-S](https://github.com/xiaowu0162/longmemeval)로 검색 품질을 측정합니다. 각 질문의 답은 과거 대화 세션 약 50개 중 하나에 묻혀 있습니다. 그 세션들을 memorize에 넣고 맞는 세션을 되찾아오는지 확인합니다.

| 모드 | recall@5 | recall@10 | recall@20 | ndcg@10 | mrr |
| --- | --- | --- | --- | --- | --- |
| lexical (BM25) | 0.966 | 0.986 | 0.994 | 0.896 | 0.911 |
| hybrid (BM25 + bge-m3) | 0.978 | 0.994 | 1.000 | 0.925 | 0.932 |

lexical 검색만으로도 질문의 96.6%에서 맞는 세션을 상위 5개 안에 찾습니다. semantic 검색은 질문과 세션이 서로 다른 단어를 쓸 때, 예를 들면 선호나 바꿔 말한 사실에서 가장 도움이 됩니다. 이 수치는 답변 정확도가 아니라 retrieval recall이며, consolidation이 아니라 검색 계층을 측정합니다. `pnpm benchmark:retrieval bm25`로 재현할 수 있습니다.

## 왜 필요한가

- **Claude 세션이 끝나면 맥락도 사라집니다.** 다음 세션에 작업, 결정, 멈춘 지점을 다시 설명해야 합니다.
- **Claude에서 Codex로 옮기면 다시 시작하게 됩니다.** 프로젝트에 공유 두뇌가 없으면 에이전트마다 기억이 따로 있습니다.
- **머신이 두 대면 프로젝트 두뇌가 나뉩니다.** 데스크톱 맥락이 자동으로 노트북까지 따라오지 않습니다.

## 작동 방식

1. **Capture.** 에이전트가 일하는 동안 훅이 파일 쓰기, 결정, 명령, 작업 전환 같은 가벼운 관찰을 기록합니다. 이 경로에서는 LLM이 실행되지 않습니다.
2. **Consolidate.** 세션 경계에서 분리된 백그라운드 프로세스가 관찰과 대화 텍스트를 장기 기억으로 정리합니다. 기억의 종류는 decision, rationale, progress입니다. 추출기는 이미 로그인한 `claude`나 `codex`, OpenAI 호환 엔드포인트, 규칙 기반 fallback을 사용할 수 있습니다.
3. **Retrieve.** 다음 세션이 열릴 때 기억들이 맥락 예산을 두고 경쟁합니다. 점수는 중요도, 최근성, 재사용, 현재 작업 관련성을 함께 봅니다. 망각은 인출 시점에만 일어나며 이벤트 로그는 append-only로 남습니다.
4. **Share.** 병렬 세션은 작업 신호와 파일 충돌 경고를 공유합니다. 선택 사항인 Hub sync를 켜면 여러 머신과 워크스페이스 멤버가 이벤트 로그를 교환합니다. 다른 멤버의 워크스페이스 기억은 별도 shared 채널로 보입니다.
5. **Separate.** 프로젝트 기억, 개인 기억, 공유 워크스페이스 기억은 분리된 채널입니다. 개인 기억은 같은 계정의 여러 프로젝트를 따라가며, 계정의 personal Hub store로만 sync됩니다. 프로젝트 워크스페이스와 섞이지 않습니다.

더 자세한 구조는 [ARCHITECTURE.md](../ARCHITECTURE.md)에 있습니다. 2층 CLS 기억 설계, 워터마크 기반 멱등 통합, 인출 시점 망각, 계정 단위 저장소, Hub workspace sync를 설명합니다.

## Local-first, optional Hub

Memorize는 특정 에이전트에 묶이지 않습니다. Claude Code와 Codex가 같은 프로젝트 기억을 읽을 수 있고, 같은 checkout 안의 여러 세션은 서로의 작업을 볼 수 있습니다. 로컬 저장소는 서버 없이 동작합니다.

Hub는 원격 조정이 필요할 때 사용합니다.

- 프로젝트를 여러 머신에 sync할 때
- 워크스페이스를 만들 때
- 멤버를 초대하거나 제거할 때
- Hub가 만든 `wsp_` id로 공유 워크스페이스 store를 라우팅할 때
- Hub가 만든 `psm_` id로 개인 기억 store를 라우팅할 때

> **지원 단계.** Claude Code가 first-class 유지보수 대상입니다. Codex, opencode, Gemini CLI, pi, Hermes, Cursor 같은 다른 harness 연동은 frozen 상태입니다. 설치는 가능하지만 conformance CI로 보장하지 않고 upstream 변화에 맞춰 따라간다고 보장하지 않습니다. 수정 PR은 환영합니다. MCP를 지원하는 host는 generic [`memorize mcp`](../../AGENT_GUIDE.md) server를 사용할 수 있습니다.

## 일상 명령어

거의 쓸 일이 없습니다. 상호작용 대부분은 AI가 처리합니다. 사람이 직접 꺼낼 만한 명령은 다음과 같습니다.

```sh
memorize doctor            # diagnose project and integration state
memorize update            # upgrade the CLI and refresh integrations machine-wide
memorize session activity  # what are my other sessions doing?
memorize consolidate       # run one memory-consolidation boundary now
memorize search <query>    # search project memory
memorize project show      # print the bound project summary (JSON)
```

나머지 명령은 모두 [AGENT_GUIDE.md](../../AGENT_GUIDE.md)에 있습니다. AI가 필요할 때 그 파일을 읽습니다.

## 현재 범위

Memorize의 현재 표면은 다음과 같습니다.

- Project memory: 프로젝트별 이벤트 로그, 통합, 검색, 세션 시작 주입, 작업 상태, handoff, 결정, conflict 기록.
- Personal memory: 선호와 작업 방식 사실을 위한 계정 단위 기억. 어떤 프로젝트에도 속하지 않으며 별도 startup 채널로 보입니다.
- Workspace memory: Hub가 뒷받침하는 선택적 공유 프로젝트 기억. `wsp_`로 라우팅되며 멤버십과 역할은 Hub control plane에 있습니다.
- Sync: canonical remote sync는 Hub를 통합니다. file transport는 기존 사용자를 위해 남아 있지만 deprecated이고 frozen입니다.
- Storage: `MEMORIZE_ROOT` 아래 account-scoped store를 사용합니다. SQLite가 프로젝트 이벤트 로그와 파생 projection store입니다.

## Status

3.0 라인은 local-first와 optional Hub를 함께 쓰는 라인입니다. 로컬 store가 세션 시작 맥락의 권위입니다. Hub state는 remote routing, credential, workspace membership, same-account personal sync에 사용됩니다. 이벤트 로그는 append-only이고, migration은 versioned이며, projection은 로그에서 다시 만들 수 있습니다.

## Community

이슈와 토론은 누구에게나 열려 있습니다. 버그 제보, 설계 토론, 사용법 질문을 환영합니다.

- 버그나 구체적 기능 요청은 [Issues](https://github.com/shakystar/memorize/issues)에 올려 주십시오.
- 설계 방향과 열린 아이디어는 [Discussions](https://github.com/shakystar/memorize/discussions)에서 나눕니다.

개발 워크플로우는 [CONTRIBUTING.md](../../.github/CONTRIBUTING.md)를 참고하십시오.

## License

AGPL-3.0-or-later. [LICENSE](../../LICENSE)를 참고하십시오.
