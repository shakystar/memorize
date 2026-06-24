<p align="center">
  <img src="https://raw.githubusercontent.com/shakystar/memorize/main/.github/assets/social-preview.png" alt="memorize: AI 코딩 에이전트를 위한 공유 기억" width="720">
</p>

# Memorize: AI 코딩 에이전트를 위한 공유 기억

[![npm](https://img.shields.io/npm/v/%40shakystar%2Fmemorize)](https://www.npmjs.com/package/@shakystar/memorize)
[![CI](https://github.com/shakystar/memorize/actions/workflows/ci.yml/badge.svg)](https://github.com/shakystar/memorize/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](../../LICENSE)

[English](../../README.md) | **한국어**

> 여러분과 Claude Code, Codex가 함께 쓰는 프로젝트 두뇌 하나입니다. 서버도 API 키도 없이, 전부 로컬에서, 사람의 기억이 실제로 작동하는 방식 그대로 동작합니다.

에이전트는 세션이 끝나는 순간 모든 것을 잊습니다. 무엇을 하던 중이었는지, 무엇을 왜 결정했는지, 어디서 멈췄는지를 다음 세션마다 다시 설명해야 합니다. memorize는 에이전트가 일하는 과정을 지켜보다가 중요한 것만 장기 기억으로 간추리고, 다음 세션이 열릴 때 알맞은 기억을 다시 꺼내 줍니다. 프로젝트에 연결된 모든 에이전트에게, 여러 머신에 걸쳐, 서버 없이 동작합니다.

## 30초 설치

memorize는 AI 어시스턴트가 프로젝트마다 직접 설치하도록 만들었습니다. Claude Code나 Codex 세션에 다음 한 줄만 보내면 됩니다.

> 다음 안내를 따라서 이 프로젝트에 memorize를 설치해 줘: https://github.com/shakystar/memorize/blob/main/guides/AI_SETUP.md

어시스턴트가 패키지를 추가하고, 디렉터리를 연결하고, 알맞은 훅을 설치하고, 기존 맥락(자체 세션 기억, 결정 문서)을 memorize로 흡수할지 확인한 뒤 설치를 검증합니다. 그다음부터는 평소처럼 `claude`나 `codex`를 사용하면 세션이 열릴 때 맥락이 자동으로 들어옵니다.

확인은 언제든 가능합니다.

```sh
npx @shakystar/memorize doctor
```

(npx로는 반드시 스코프가 붙은 이름을 사용하십시오. 스코프 없는 `memorize`는 전혀 다른 패키지입니다.)

직접 PATH에 올리고 싶다면 [AI_SETUP.md](../../guides/AI_SETUP.md)에 수동 설치 방법도 있습니다. Node.js 22 이상이 필요합니다.

## 세션 시작 시 에이전트가 보는 것

```text
# Memorize context

기본 규칙: memorize가 프로젝트 상태의 유일한 진실 원천이다 …

프로젝트: 실시간 화이트보드 MVP
작업: 원격 드래그에서 커서가 떨리는 문제 수정
최근 인계: codex가 남김. "재현 범위를 useRemoteCursor의 throttle로
  좁혔음. 실패하는 테스트를 cursor-sync.test.ts에 추가해 둠"
통합된 기억:
- [decision/s9] v1 전송 방식은 WebRTC 대신 WebSocket. 인프라가 단순하고,
  RTT 200ms 초과가 흔해지면 그때 다시 검토
- [rationale/s7] 커서 좌표는 일부러 throttle 없이 보낸다. 떨림의 원인은
  대역폭이 아니라 이중 throttle이었다
- [progress/s5] LAN 동기화 확인. 떨림은 RTT 80ms 위에서만 재현됨
직전 세션 작업 흔적:
- [write-tool/Edit] src/hooks/useRemoteCursor.ts
- [decision-keyword/Bash] git commit -m "remove inner throttle"
```

다시 설명할 필요가 없습니다. 다음 에이전트가, 그것이 어떤 에이전트든 어떤 머신이든, 정확히 이 지점에서 이어받습니다.

## 실사용 증거

3일 동안 사람 손을 대지 않고 운영한 실사용(dogfooding)에서 나온 수치입니다.

- **포착한 관찰 667개 중 654개를 기억으로 전환했습니다.** 전환율 98%입니다.
- **기억 117개가 여러 세션에 407번 주입됐습니다.** 가장 많이 쓰인 항목(커밋 해시, 필드 이름)은 각각 19~21번이었습니다. 엔지니어가 손으로 챙길 법한 바로 그런 정보입니다.
- **낡은 사실 29건이 최신 사실로 자동 교체됐습니다.** 한 번 쓰고 버리는 방식이 아니라, 살아 있는 상태로 정리됩니다.
- **추가 비용은 코딩 토큰의 약 0.25%입니다.** 가장 보수적으로 잡아도 1.8%입니다.
- **훅이 포착하고, 통합하고, 교체하고, 주입하는 전 과정이 사람 개입 없이 돌아갑니다.**
- **병렬 세션이 같은 파일을 건드리면 그 자리에서 경고가 뜹니다.**

> 정식 retrieval 정확도 벤치마크는 측정 중입니다. 결과는 곧 이 자리에 채웁니다.

## 왜 필요한가

- **Claude 세션이 끝나면 맥락도 함께 사라집니다.** 다음 세션에 무엇을 하던 중이었고, 무엇을 결정했고, 어디서 멈췄는지를 다시 설명하게 됩니다.
- **Claude에서 Codex로 옮기면 처음부터 다시 시작합니다.** 에이전트마다 기억이 따로 놀고, 서로의 메모를 보지 못합니다.
- **머신이 두 대면 두뇌가 반쪽씩 나뉩니다.** 데스크톱에 쌓인 맥락이 노트북까지 따라오지 않습니다.

## 작동 방식

1. **포착.** 에이전트가 일하는 동안 훅이 가볍고 규칙으로 거른 관찰만 기록합니다(파일 쓰기, 결정, 작업 전환). LLM도 지연도 없습니다.
2. **통합.** 세션 경계에서 분리된 백그라운드 프로세스가 관찰과 대화 자체를 장기 기억(결정, 근거, 진행)으로 간추리고 중요도 점수를 매깁니다. 추출기는 이미 사용 중인 `claude`나 `codex` 로그인을 그대로 사용하므로 API 키가 필요 없습니다. OpenAI 호환 엔드포인트나 규칙 기반 폴백도 지원합니다.
3. **인출.** 다음 세션이 열리면 기억들이 맥락 예산을 두고 경쟁합니다. 기준은 중요도와 최근성(14일 반감기, 다시 쓰이면 강화), 그리고 지금 작업과의 관련성을 곱한 값입니다. 망각은 인출 시점에만 일어나며, 실제로 지워지는 것은 하나도 없습니다.
4. **공유.** 병렬 세션이 서로의 작업을 실시간으로 봅니다(파일 충돌 경고 포함). 같은 이벤트 로그가 여러 머신 사이에서 동기화되고 결정론적으로 수렴합니다. 기억끼리 모순되면 감지해서 해소합니다. 최신 기억이 이기고, 옛 기억은 복원할 수 있는 상태로 남습니다.

더 깊은 내용은 [ARCHITECTURE.md](../ARCHITECTURE.md)에 있습니다. 2층 CLS 기억 설계, 워터마크로 멱등성을 보장하는 통합, 인출 시점 망각, dogfooding 데이터로 스키마를 진화시키는 lifecycle-evidence 프로그램을 다룹니다.

## 모든 에이전트, 모든 머신

memorize는 특정 에이전트에 묶이지 않습니다. Claude Code와 Codex가 같은 프로젝트 두뇌를 공유하고, 데스크톱과 노트북이 같은 이벤트 로그를 봅니다. 서버도 중앙 API도 벤더 종속도 없으며, 전부 로컬 우선이고 이벤트 소싱 방식입니다.

## 일상 명령어

거의 쓸 일이 없습니다. 상호작용 대부분은 AI가 알아서 처리합니다. 사람이 직접 꺼낼 만한 명령은 다음과 같습니다.

```sh
memorize doctor            # 프로젝트와 연동 상태 진단
memorize update            # CLI 업그레이드와 연동 갱신 (머신 전체)
memorize session activity  # 내 다른 세션들이 무엇을 하고 있는지 확인
memorize consolidate       # 기억 통합 경계를 지금 한 번 실행
memorize search <query>    # 프로젝트 기억 검색
memorize project show      # 연결된 프로젝트 요약 출력 (JSON)
```

나머지 명령은 모두 [AGENT_GUIDE.md](../../AGENT_GUIDE.md)에 있습니다. AI가 필요할 때 그 파일을 읽습니다.

## 한계와 로드맵

지금까지 검증된 범위를 솔직하게 적습니다. 모두 다음 단계에서 고도화할 항목입니다.

- **3일 규모에서 확인했습니다.** 수개월, 수백 개 기억 규모의 성능은 아직 증명하지 못했습니다.
- **임베딩 기반 검색은 아직 검증하지 않았습니다.**
- **결정 포착이 파일 쓰기와 명령 쪽에 치우쳐 있습니다**(신호의 99.8%). 명시적 결정 키워드 포착은 개선 중입니다.

벤치마크, 임베딩 검색, 결정 포착은 모두 진행 중인 다음 마일스톤입니다.

## AI 어시스턴트용

AI 코딩 어시스턴트이고 사용자가 memorize 설치를 요청했다면 [guides/AI_SETUP.md](../../guides/AI_SETUP.md)를 따르십시오. 멱등한 설치 단계, 기존 맥락 흡수 흐름, 기본 규칙(memorize가 유일한 진실 원천이며 그 상태를 자체 기억에 중복 저장하지 않는다)이 담겨 있습니다. 명령 동작 전체는 [AGENT_GUIDE.md](../../AGENT_GUIDE.md)에 있습니다.

## Status

memorize는 `2.x` 라인입니다(2.0.0부터 AGPL-3.0-or-later). 호환성 약속은 디스크 이벤트 로그 레이아웃, 위에 적은 일상 CLI, 설치 훅 계약까지 보장합니다. 메이저 라인 안에서는 이 약속을 깨지 않습니다. 이벤트 로그에는 버전이 기록돼 있고 프로젝션은 재생성할 수 있으므로, 메이저 안 업그레이드는 수동 데이터 마이그레이션이 필요 없습니다.

## Community

이슈와 토론은 누구에게나 열려 있습니다. 버그 제보, 설계 토론, 사용법 질문을 모두 환영합니다.

- 버그나 구체적 기능 요청은 [Issues](https://github.com/shakystar/memorize/issues)에 올려 주십시오.
- 설계 방향이나 열린 아이디어는 [Discussions](https://github.com/shakystar/memorize/discussions)에서 나눕니다(기억 분류 체계 토론이 여기 있습니다).

개발 워크플로우는 [CONTRIBUTING.md](../../.github/CONTRIBUTING.md)를 참고하십시오.

## License

AGPL-3.0-or-later. [LICENSE](../../LICENSE)를 참고하십시오.
