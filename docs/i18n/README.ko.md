<p align="center">
  <img src="https://raw.githubusercontent.com/shakystar/memorize/main/.github/assets/hero-logo-readme-crow.png" alt="memorize: AI 코딩 에이전트를 위한 공유 기억" width="720">
</p>

<h1 align="center">Memorize</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@shakystar/memorize"><img src="https://img.shields.io/npm/v/%40shakystar%2Fmemorize" alt="npm"></a>
  <a href="https://www.npmjs.com/package/@shakystar/memorize"><img src="https://img.shields.io/npm/dm/%40shakystar%2Fmemorize" alt="downloads"></a>
  <a href="https://github.com/shakystar/memorize/actions/workflows/ci.yml"><img src="https://github.com/shakystar/memorize/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@shakystar/memorize"><img src="https://img.shields.io/node/v/%40shakystar%2Fmemorize" alt="node"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license"></a>
</p>

<p align="center">
  <a href="../../AGENT_GUIDE.md">Agent Guide</a> ·
  <a href="../ARCHITECTURE.md">Architecture</a> ·
  <a href="../../guides/AI_SETUP.md">Setup</a> ·
  <a href="https://github.com/shakystar/memorize/issues">Issues</a> ·
  <a href="https://github.com/shakystar/memorize/discussions">Discussions</a> ·
  <a href="../../README.md">English</a>
</p>

---

Claude Code와 Codex를 위한 공유 가능한 영속 기억입니다.

Memorize는 코딩 에이전트가 하는 일 — 파일 쓰기, 결정, 명령 — 을 기록하고, 장기 기억으로 정리하고, 다음 세션이 시작될 때 알맞은 맥락을 주입합니다. local-first라 오프라인에서도 동작하며, 선택 사항인 Hub가 머신 간·팀 동기화를 더합니다.

## Highlights

- **다시 설명할 필요가 없습니다.** 결정, 근거, 진행 상황이 세션 종료와 에이전트 전환을 넘어 살아남습니다.
- **API 키가 필요 없습니다.** 통합은 이미 로그인한 `claude`/`codex`, OpenAI 호환 엔드포인트, 규칙 기반 fallback을 사용합니다.
- **서버도 포트도 없습니다.** 훅이 호출하는 stateless CLI라 켜 둘 것이 없습니다.
- **아무것도 사라지지 않습니다.** append-only 이벤트 로그. 망각은 인출 시점에만 일어나고 projection은 언제든 다시 만들 수 있습니다.
- **캡처에 LLM이 없습니다.** 캡처 hot path는 규칙 기반이라 토큰도 지연도 들지 않습니다.
- **세 개의 분리된 채널.** 프로젝트, 개인, 공유 워크스페이스 기억이 구조적으로 분리됩니다.
- **팀과 멀티 머신 준비 완료.** 선택 사항인 Hub가 머신과 워크스페이스 멤버 간에 이벤트 로그를 동기화합니다.

## Install

Node.js 22.9 이상이 필요합니다. npx로는 반드시 스코프가 붙은 이름을 사용하십시오 — 스코프 없는 `memorize`는 전혀 다른 npm 패키지입니다.

**권장 — AI에게 설치를 맡기십시오.** Memorize는 AI 어시스턴트가 프로젝트마다 설치하도록 설계되어 있습니다. Claude Code나 Codex 세션에 다음 한 줄을 보내면 됩니다.

> 다음 안내를 따라서 이 프로젝트에 memorize를 설치해 줘: https://github.com/shakystar/memorize/blob/main/guides/AI_SETUP.md

어시스턴트가 패키지를 추가하고, 현재 디렉터리를 프로젝트에 연결하고, 맞는 훅을 설치하고, 기존 프로젝트 맥락을 흡수할지 확인한 뒤 설치를 검증합니다. 그 다음부터는 평소처럼 `claude`나 `codex`를 사용하면 됩니다. 세션이 열릴 때 맥락이 자동으로 들어옵니다.

**직접 설치.** PATH에 `memorize`를 직접 올리고 훅을 손으로 연결하는 방법은 [AI_SETUP.md](../../guides/AI_SETUP.md)에 있습니다.

**확인은 언제든 가능합니다.**

```sh
npx @shakystar/memorize doctor
```

**소스에서 빌드.** pnpm workspace 설정과 개발 워크플로우는 [CONTRIBUTING.md](../../.github/CONTRIBUTING.md)를 참고하십시오.

## Memorize 비교

가장 가까운 오픈소스 대안인 [agentmemory](https://github.com/rohitg00/agentmemory), 그리고 기본 `CLAUDE.md` 방식과 비교하면 다음과 같습니다.

| | **memorize** | agentmemory | 기본 (`CLAUDE.md`) |
| --- | --- | --- | --- |
| 저장 모델 | append-only 이벤트 로그(SQLite) + 재생성 가능한 projection | mutable KV 파일 스토어 + 라이브 스트림 | 정적 markdown 파일 |
| Retrieval R@5 (LongMemEval-S) | **0.978** hybrid / 0.966 lexical — `pnpm benchmark:retrieval`로 재현 | 0.952 (공개 수치) | — (검색 없음) |
| 캡처 | 자동 훅, 규칙 기반 — hot path에 LLM 없음 | 자동 훅, 기본은 synthetic compression | 수동 편집 |
| API 키 없는 통합 | 가능 — 로그인한 `claude`/`codex` CLI, OpenAI 호환 엔드포인트, 규칙 기반 fallback | LLM compression에 API 키 필요 | — |
| 검색 | BM25(FTS5) + 선택적 semantic, RRF fusion | BM25 + vector + graph, RRF fusion (vector는 임베더 설정 필요) | — |
| 망각 | 인출 시점만 — 아무것도 삭제되지 않고 supersede는 복원 가능 | TTL 기반 eviction (하드 삭제) | 수동 |
| 충돌 처리 | LLM-judge 모순 검출, 결정론적 승자 | lexical 유사도 기반 모순 검사 | — |
| 멀티 머신 / 팀 | 선택 사항인 Hub로 이벤트 로그 sync, 결정론적 수렴 | HTTP mesh, last-write-wins | 파일을 손으로 복사 |
| 런타임 | stateless CLI — 데몬 없음, 열린 포트 없음 | 상시 가동 서버 스택 (REST, stream, viewer 포트) | 없음 |
| 에이전트 지원 | Claude Code first-class. Codex 외 5종(frozen tier), generic MCP server | 20+ 에이전트, MCP + REST | Claude Code |

> agentmemory v0.9.27 (2026년 6월) 기준이며, 마케팅 문구가 아니라 양쪽 코드베이스로 확인한 내용입니다. 프로젝트마다 벤치마크 구성이 다르므로 교차 비교 수치는 방향성 참고로만 보십시오. memorize의 수치는 이 레포에서 재현할 수 있습니다.

### Retrieval 벤치마크

검색 품질은 공개 500문항 장기기억 벤치마크 [LongMemEval-S](https://github.com/xiaowu0162/longmemeval)로 측정합니다. 각 질문의 답은 과거 대화 세션 약 50개 중 하나에 묻혀 있습니다. 그 세션들을 memorize에 넣고 맞는 세션을 되찾아오는지 확인합니다.

| 모드 | recall@5 | recall@10 | recall@20 | ndcg@10 | mrr |
| --- | --- | --- | --- | --- | --- |
| lexical (BM25) | 0.966 | 0.986 | 0.994 | 0.896 | 0.911 |
| hybrid (BM25 + bge-m3) | 0.978 | 0.994 | 1.000 | 0.925 | 0.932 |

이 수치는 답변 정확도가 아니라 retrieval recall이며, consolidation이 아니라 검색 계층을 측정합니다. `pnpm benchmark:retrieval bm25`로 재현할 수 있습니다.

## Usage

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

> **지원 단계.** Claude Code가 first-class 유지보수 대상입니다. Codex, opencode, Gemini CLI, pi, Hermes, Cursor 같은 다른 harness 연동은 frozen 상태입니다. 설치는 가능하지만 conformance CI로는 보장하지 않습니다. MCP를 지원하는 host는 generic [`memorize mcp`](../../AGENT_GUIDE.md) server를 사용할 수 있습니다.

## Status

3.0 라인은 local-first와 optional Hub를 함께 쓰는 라인입니다. 로컬 store가 세션 시작 맥락의 권위입니다. Hub state는 remote routing, credential, workspace membership, same-account personal sync에 사용됩니다. 이벤트 로그는 append-only이고, migration은 versioned이며, projection은 로그에서 다시 만들 수 있습니다.

## 목적별 문서

| 하려는 일 | 읽을 문서 |
| --- | --- |
| 프로젝트에 memorize 설치 | [guides/AI_SETUP.md](../../guides/AI_SETUP.md) |
| 명령·플래그·실패 모드 전체 참조 | [AGENT_GUIDE.md](../../AGENT_GUIDE.md) |
| 기억 설계 이해 | [docs/ARCHITECTURE.md](../ARCHITECTURE.md) |
| 이 문서를 영어로 읽기 | [README.md](../../README.md) |
| 코드 기여 | [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) |
| 보안 이슈 제보 | [SECURITY.md](../../SECURITY.md) |

## Community

이슈와 토론은 누구에게나 열려 있습니다. 버그 제보, 설계 토론, 사용법 질문을 환영합니다.

- 버그나 구체적 기능 요청은 [Issues](https://github.com/shakystar/memorize/issues)에 올려 주십시오.
- 설계 방향과 열린 아이디어는 [Discussions](https://github.com/shakystar/memorize/discussions)에서 나눕니다.

개발 워크플로우는 [CONTRIBUTING.md](../../.github/CONTRIBUTING.md)를 참고하십시오.
