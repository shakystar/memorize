# Memorize — AI 코딩 에이전트를 위한 공유 메모리

[![npm](https://img.shields.io/npm/v/%40shakystar%2Fmemorize)](https://www.npmjs.com/package/@shakystar/memorize)
[![CI](https://github.com/shakystar/memorize/actions/workflows/ci.yml/badge.svg)](https://github.com/shakystar/memorize/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](../../LICENSE)

[English](../../README.md) | **한국어** | [日本語](./README.ja.md) | [简体中文](./README.zh-CN.md) | [Español](./README.es.md)

<p align="center">
  <img src="../../.github/assets/social-preview.png" alt="memorize — shared memory for AI coding agents" width="720">
</p>


> 당신과 Claude Code, Codex가 하나의 영속적인 프로젝트 두뇌를 공유합니다 —
> 로컬 우선, 이벤트 소싱, 생물학적 기억의 작동 방식을 본뜬 설계.

에이전트는 세션이 끝나면 모든 걸 잊습니다. Memorize는 에이전트가 일하는
동안 지켜보다가, 중요했던 것을 장기 기억으로 증류하고, 다음 세션이 시작될
때 딱 맞는 기억을 다시 주입합니다 — 프로젝트의 **모든** 에이전트에게,
머신을 넘나들며, 서버도 API 키도 없이.

## 왜 필요한가

- **Claude 세션이 끝나면 컨텍스트도 함께 죽습니다.** 다음 세션에서 뭘 하고
  있었는지, 뭘 결정했는지, 어디서 멈췄는지 다시 설명해야 합니다.
- **Claude에서 Codex로 갈아타면 처음부터 다시 시작입니다.** 에이전트마다
  자기만의 메모리 저장소가 있고, 서로의 노트를 보지 못합니다.
- **머신이 두 대면 두뇌도 반쪽씩 두 개.** 데스크톱의 컨텍스트는 노트북으로
  따라오지 않습니다.

## 동작 방식

1. **캡처** — 에이전트가 일하는 동안 훅이 저렴한 규칙 기반 관측(파일 수정,
   결정, 태스크 전환)을 기록합니다. LLM 없음, 지연 없음.
2. **통합** — 세션 경계마다 백그라운드 프로세스가 관측과 대화 자체를 장기
   기억(결정, 근거, 진행 상황)으로 증류하고 중요도 점수를 매깁니다. 추출은 이미
   로그인된 `claude` / `codex` CLI를 통해 돌아갑니다 — API 키 불필요.
   OpenAI 호환 엔드포인트나 규칙 기반 폴백도 지원합니다.
3. **인출** — 다음 세션 시작 시 기억들이 중요도 × 최신성(반감기 14일,
   재사용 시 강화) × 현재 작업과의 관련성으로 컨텍스트 예산을 두고
   경쟁합니다. 망각은 인출 시점에만 일어나며, 어떤 것도 삭제되지 않습니다.
4. **공유** — 병렬 세션끼리 서로의 작업을 실시간으로 봅니다(파일 충돌
   경고 포함). 같은 이벤트 로그가 머신 간에 동기화되고 결정론적으로
   수렴합니다. 기억 간 모순은 자동 감지·해소됩니다 — 새것이 이기고,
   옛것은 복원 가능하게 남습니다.

더 깊은 이야기 — 2층 CLS 메모리 설계, 워터마크 멱등 통합, 인출 시점
망각, dogfooding 데이터로 스키마를 진화시키는 수명 증거 프로그램 — 는
**[ARCHITECTURE.md](../ARCHITECTURE.md)** (영문)에 있습니다.

### 세션 시작 시 에이전트가 보는 것

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

다시 설명할 필요가 없습니다. 다음 에이전트는 — 어떤 에이전트든, 어떤
머신이든 — 정확히 여기서 이어받습니다.

## 설치

두 가지 방법이 있습니다. **대부분은 첫 번째를 쓰면 됩니다** — memorize는
AI 어시스턴트가 프로젝트별로 설치해 주도록 만들어졌습니다.

### 권장 — AI에게 셋업을 맡기세요

Claude Code나 Codex 세션에 프롬프트 한 줄을 보내면 됩니다:

> Set up memorize in this project. Follow the instructions at
> https://github.com/shakystar/memorize/blob/main/guides/AI_SETUP.md

어시스턴트가 패키지를 추가하고, 디렉터리를 바인딩하고, 알맞은 에이전트
훅을 설치하고, 기존 컨텍스트(자신의 세션 메모리, 당신의 결정 문서)를
memorize로 흡수할지 제안하고, 설치를 검증합니다. 그다음부터는 평소처럼
`claude` / `codex`를 쓰면 됩니다 — 세션 시작 시 컨텍스트가 자동
주입됩니다.

언제든 다음으로 확인할 수 있습니다:

```sh
npx @shakystar/memorize doctor
```

(npx에서는 항상 스코프가 붙은 이름을 쓰세요 — npm의 스코프 없는
`memorize`는 무관한 패키지입니다.)

### 수동 — 직접 PATH에 올리기

<details>
<summary>한 줄 설치 (전역 바이너리 + <code>memorize setup</code>)</summary>

```sh
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/shakystar/memorize/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/shakystar/memorize/main/scripts/install.ps1 | iex
```

전역 바이너리를 설치한 뒤 `memorize setup`이 실행되어 Claude Code와
Codex를 감지합니다. Codex 통합은 그 자리에서 전역으로 와이어링되고,
Claude 훅은 프로젝트별이라 memorize를 쓰고 싶은 각 프로젝트 안에서
`memorize install claude`를 실행하라고 안내합니다.

Node.js >= 22가 필요합니다. 설치 스크립트가 확인하고, 없으면 어디서
받을지 알려줍니다.

</details>

## 작업 디렉터리

- memorize 명령은 프로젝트 안 어디서든 실행할 수 있습니다 — 현재
  디렉터리에서 위로 올라가며 가장 가까운 바인딩된 프로젝트를 찾습니다
  (git과 같은 방식).
- 프로젝트의 `.memorize/`에는 프로젝트별 런타임 상태가 들어갑니다.
  **`.gitignore`에 `.memorize/`를 추가하세요**; 빠져 있으면 `doctor`가
  경고합니다.
- 영속 이벤트 로그는 기본적으로 `~/.memorize/`에 저장됩니다
  (`MEMORIZE_ROOT`로 변경 가능).

## 일상 명령어

대부분은 AI가 알아서 합니다. 사람이 직접 쓸 만한 것들:

```sh
memorize doctor            # 프로젝트 + 통합 상태 진단
memorize update            # CLI 업그레이드 + 머신 전체 통합 갱신
memorize session activity  # 다른 세션들은 뭘 하고 있지?
memorize consolidate       # 기억 통합 경계를 지금 한 번 실행
memorize search <query>    # 프로젝트 기억 검색
memorize project show      # 바인딩된 프로젝트 요약 출력 (JSON)
memorize version           # 실제로 실행된 바이너리의 버전
```

태스크와 핸드오프(`memorize task …`)는 에이전트 간 명시적 조정을 위한
선택적 계층입니다 — 자동 기억은 이것들 없이 동작하며, 태스크 목록이
비어 있는 것은 정상입니다.

`memorize`만 치면 사용법 개요가 나옵니다. 나머지 모든 명령(setup,
install, memory import, hook, projection rebuild, sync 등)은
[AGENT_GUIDE.md](../../AGENT_GUIDE.md)에 문서화돼 있습니다 — AI가 자세한
내용이 필요할 때 읽는 파일입니다.

## 문제 해결

- 설치가 중간에 에러로 멈춤 — 에러 출력 전체를 Claude/Codex 세션에
  붙여넣고 [AI_SETUP.md](../../guides/AI_SETUP.md) 링크를 함께 주세요.
  그 안의 "Recovering a failed install" 섹션이 에이전트에게 일반적인
  원인(Node 버전, npm 전역 권한, PATH, WSL 가림)을 순서대로 점검시킵니다.
  에이전트가 없다면 **Install failure** 이슈 템플릿으로 제보해 주세요.

- Claude 세션에 memorize 컨텍스트가 안 보임 — `memorize doctor`를
  실행하고 실패한 체크의 `fix:` 항목을 따르세요. 보통
  `memorize install claude` 재실행으로 해결됩니다.
- 설치는 됐는데 Codex가 아무것도 기록하지 않음 — codex는 외부에서
  작성된 훅을 대화형 세션에서 한 번 승인해야 실행합니다. `doctor`가
  이 상태를 감지해서 알려줍니다.
- 태스크를 만들었는데 목록이 비어 있음 — `memorize project show`로
  프로젝트 id가 일치하는지 확인하세요. 다른 바인딩된 프로젝트 안에 있을
  수 있습니다.
- 프로젝트에서 완전히 제거하기:
  - `memorize uninstall claude` / `memorize uninstall codex` —
    memorize 훅과 ground-rule 블록을 제거하되 다른 훅/설정은
    보존합니다. 멱등. 캡처된 기억은 그대로 남습니다.
  - 프로젝트의 `.memorize/` 삭제 — 프로젝트별 런타임 상태 제거
  - 선택적으로 `rm -rf ~/.memorize` — 모든 프로젝트의 영속 이벤트
    로그 삭제. 캡처된 기억을 지우는 유일한 단계입니다.

## AI 어시스턴트라면

사용자가 memorize 셋업을 요청했다면
[guides/AI_SETUP.md](../../guides/AI_SETUP.md)를 따르세요 — 멱등 셋업 단계,
기존 컨텍스트 흡수 흐름, 그리고 ground rule(memorize가 단일 진실
공급원; 그 상태를 자신의 메모리에 중복 저장하지 말 것)이 담겨 있습니다.
전체 명령 동작은 [AGENT_GUIDE.md](../../AGENT_GUIDE.md)를 보세요.

## 상태

Memorize는 `2.x` 라인입니다 (2.0.0부터 AGPL-3.0-or-later). 호환성
약속은 다음을 포함합니다:

- 디스크상의 이벤트 로그 레이아웃과 프로젝트별 `.memorize/` 디렉터리 형태
- 위에 나열된 일상 CLI 표면
- `install claude` / `install codex`가 작성하는 훅 계약

메이저 라인 안에서는 이것들을 깨지 않습니다. 이벤트 로그는 버전이
관리되고 프로젝션은 재생성 가능하므로, 메이저 버전 내 업그레이드에 수동
데이터 마이그레이션이 필요 없습니다.

**실험적** (마이너 릴리스에서 변경될 수 있음):

- `memorize project sync` — 파일 전송은 동작하며 라운드트립 테스트
  완료. HTTP 릴레이 클라이언트는 포함됐지만 별도의 릴레이 서버(준비 중)가
  필요합니다.
- 통합 기억의 관찰 전용 수명 증거 필드와 `consolidate --report` 형식 —
  분류 체계 결정이 내려지면 바뀔 수 있는 계측입니다.

릴리스 이력은 [CHANGELOG.md](../../CHANGELOG.md)를 보세요.

## 커뮤니티

이슈와 토론은 누구에게나 열려 있습니다 — 버그 리포트, 설계 논쟁,
"이거 어떻게 해요" 질문 모두 환영합니다:

- **[Issues](https://github.com/shakystar/memorize/issues)** — 버그와
  구체적인 기능 요청
- **[Discussions](https://github.com/shakystar/memorize/discussions)** —
  설계 방향과 열린 아이디어 (기억 분류 체계 논쟁이 여기서 벌어집니다)

개발 워크플로는 [CONTRIBUTING.md](../../.github/CONTRIBUTING.md)를 보세요.

## 라이선스

AGPL-3.0-or-later. [LICENSE](../../LICENSE) 참조.
