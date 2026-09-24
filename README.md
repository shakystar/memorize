# Memorize — AI 코딩 에이전트를 위한 지속형 공유 기억

<p align="center">
  <img src="https://github.com/user-attachments/assets/a674a964-d875-4439-87db-8c18ad8222da" alt="Memorize — AI 코딩 에이전트를 위한 공유 기억" width="720">
</p>

**2026 공군창업경진대회 우수상 수상 프로젝트 · 개발 종료 · MIT 라이선스**

Memorize는 AI 코딩 에이전트가 세션을 바꿀 때마다 프로젝트의 결정과 작업 맥락을 잃는 문제에서 출발했다. 파일 수정·명령·관찰을 이벤트로 저장하고, 기억으로 정리한 뒤 다음 세션에 필요한 맥락을 주입한다. 로컬 저장을 기본으로 하며, 선택적 [memorize_hub](https://github.com/shakystar/memorize_hub)를 통해 기기와 워크스페이스 사이의 이벤트를 동기화한다.

이 저장소는 구현·검증·설계 변경의 기록을 포트폴리오와 연구 참고용으로 보존한다. 신규 기능 개발, 정기 유지보수, 보안 업데이트는 계획하지 않는다. 기존 배포 주소의 운영이나 최신 에이전트와의 호환성을 보장하지 않는다.

## 수상과 프로젝트의 흐름

- **2026 공군창업경진대회 우수상**: 예선에는 아이디어와 v1.0.0, 결선에는 v3.0.0으로 출품했다. 출품 버전은 작성자의 대회 기록에 따른다. 현재 main의 모든 기능이 수상 당시 검증됐다는 의미는 아니다.
- Hub를 실제 물리 기기 두 대에서 동기화 테스트했고 작성자와 팀원이 함께 사용했다.
- 직접 사용하면서 단기 관찰과 장기 기억의 압축, 프로젝트·개인·공유 기억의 경계, 여러 에이전트 사이의 맥락 전달을 발전시켰다.
- 이후 탐구 범위를 에이전트 실행과 협업으로 넓혀 [mori](https://github.com/shakystar/mori)와 [mori-nest](https://github.com/shakystar/mori-nest)로 이어갔다. 두 후속 프로젝트도 개발을 종료했다.
- 군 복무 중 확보 가능한 개발 시간, 모델 API·반복 평가 비용, 관련 도구의 등장까지 고려해 이 프로젝트군의 추가 개발과 유지보수를 마무리했다. 이 설명은 이번 최종 정리의 판단이며, 과거 archive 당시의 상세 의사결정을 소급해 단정하는 것은 아니다.

작성자는 문제 정의, 단기·장기 기억 구조, 주요 설계와 개발 방향을 결정하고 실사용했다. AI 코딩 에이전트를 구현·테스트·리뷰에 활용했다. 자세한 내용은 [최종 구현·검증 상태](./docs/final-status.md)와 [설계·검증 사례](./docs/case-study.md)에 기록했다.

## 어디까지 구현했나

| 영역 | 저장소에서 확인할 수 있는 구현 |
| --- | --- |
| 저장 | SQLite 기반 append-only 이벤트 로그, 재구성 가능한 projection, 계정·프로젝트별 저장 경로 |
| 기억 | 규칙 기반 관찰 수집, CLI·모델·규칙 기반 consolidation 경로, 기억의 대체·철회 및 검색 |
| 검색 | FTS5/BM25, 선택적 임베딩과 RRF 결합, 검색 평가 하네스 |
| 에이전트 연동 | Claude Code 중심 훅, Codex 등 다른 어댑터, 범용 MCP 서버 |
| 공유 | 파일·HTTP 전송, Hub 로그인·개인 저장소·워크스페이스 동기화, 출처와 작성자 구분 |
| 검증·운영 도구 | 단위·통합·golden 테스트, 설치 진단, 패키징 검사, 수집·검색·설치 평가 도구 |

모든 정보를 빠짐없이 기억한다거나 일반적인 답변 품질 향상을 입증했다는 뜻은 아니다. 다른 에이전트 어댑터는 종료 전부터 유지보수가 동결됐고, 현재는 Claude Code를 포함한 전체 프로젝트가 보존 상태다.

## 무엇을 검증했나

기준 코드는 v3.1.0의 `d4f4f912924fd75f0d8e32d8b6fd446f304d8ba4`이다.

- 당시 [마지막 CI](https://github.com/shakystar/memorize/actions/runs/29632255207)에서 Linux·macOS 테스트, 타입 검사·린트, Linux·Windows 빌드·패키징 검사는 통과했다.
- Windows 통합 테스트의 `release-packaging.test.ts` 한 건은 **30초 시간 초과로 실패**했다. Windows 전체 검증 성공으로 표시하지 않는다.
- 저장된 LongMemEval-S 500문항 검색 결과는 아래와 같다. 이번 종료 정리에서 모델·임베딩 API를 호출해 재측정한 수치가 아니다.

| 검색 방식 | recall@5 | recall@10 | recall@20 | ndcg@10 | mrr |
| --- | --- | --- | --- | --- | --- |
| BM25 | 0.966 | 0.986 | 0.994 | 0.896 | 0.911 |
| BM25 + bge-m3 | 0.978 | 0.994 | 1.000 | 0.924 | 0.932 |

근거: [bm25.json](./bm25.json), [hybrid.json](./hybrid.json). 이는 **관련 기록을 검색하는 점수**이며, 답변 정확도·자동 수집의 누락률·실사용 생산성이나 다른 제품 대비 우위를 입증하지 않는다. 미완료 작업과 평가 한계는 [최종 상태](./docs/final-status.md)를 참고한다.

## 소스에서 실행하기

Node.js 22.9 이상과 저장소에 지정된 pnpm 10.30.3을 사용한다.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

설치·훅 연결 절차는 [설치 안내](./guides/AI_SETUP.md), 명령과 오류 처리의 상세는 [에이전트 사용 안내](./AGENT_GUIDE.md)에 남겨 두었다. 이 문서들은 개발 당시 동작을 설명하며 현재 외부 CLI와의 호환성을 보장하지 않는다.

```sh
memorize doctor            # 프로젝트와 연동 상태 진단
memorize session activity  # 다른 세션의 작업 확인
memorize consolidate       # 기억 정리 실행
memorize search <query>    # 프로젝트 기억 검색
memorize project show      # 연결된 프로젝트 요약 출력
```

모델 기반 consolidation과 임베딩 평가는 별도 인증과 비용이 발생할 수 있다. 기본 수집 경로는 규칙 기반이다. Hub 없이 로컬 기능을 사용할 수 있으며, 보관된 공개 Hub 주소 대신 본인이 운영하는 환경의 설정을 확인해야 한다.

## 문서와 라이선스

- [최종 구현·검증 상태](./docs/final-status.md)
- [설계·검증 사례](./docs/case-study.md)
- [아키텍처](./docs/ARCHITECTURE.md), [기능별 문서](./docs/functions/README.md)
- [소스 검증·포크 안내](./.github/CONTRIBUTING.md), [보안 유지보수 상태](./SECURITY.md)

현재 소스는 [MIT 라이선스](./LICENSE)로 공개한다. 과거 태그의 라이선스와 외부 데이터셋·의존성의 라이선스는 각 배포물의 고지를 따른다. 이 저장소의 종료 정리가 기존 npm 배포물을 새로 발행하거나 수정하지는 않는다.
