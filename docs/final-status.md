# Memorize 최종 구현·검증 상태

정리일: 2026-09-24. 구현 기준: `d4f4f912924fd75f0d8e32d8b6fd446f304d8ba4` (package.json 3.1.0).

## 보존 목적과 수상 범위

2026 공군창업경진대회 우수상 수상 프로젝트다. 작성자 기록상 예선은 아이디어와 v1.0.0, 결선은 v3.0.0으로 출품했다. 출품물과 현재 main을 동일시하지 않으며, 버전 이름만으로 저장소 태그의 모든 변경이 심사 대상이었다고 단정하지 않는다.

로컬 기억 수집·정리·공유를 직접 개발·사용한 뒤, 후속 mori·mori-nest에서 에이전트 실행·협업으로 실험 범위를 넓혔다. 이번에는 군 복무의 시간 제약, 모델 API·반복 평가 비용, 관련 도구의 등장을 고려해 전체 프로젝트군을 종료 상태로 정리한다. 기존 memorize archive는 2026-08-29의 GitHub 보관 안내에서 확인했으며, 당시 상세 의사결정과 이번 최종 정리의 사유를 혼동하지 않는다.

작성자는 Hub의 실제 물리 기기 두 대 동기화 테스트와 본인·팀원의 실사용을 2026-09-24에 확인했다. 이는 검색 벤치마크나 컨테이너 실험과 별개의 실사용 근거이며, 사용 기간·지연 수치를 임의로 덧붙이지 않는다.

## 구현 근거

| 영역 | 근거 경로 | 해석 범위 |
| --- | --- | --- |
| 로컬 이벤트·projection | `src/storage/event-store.ts`, `src/storage/db.ts`, `src/projections/projector.ts` | 이벤트를 원본으로 삼고 파생 상태를 재구성하는 구현 |
| 관찰·기억 정리 | `src/services/capture-service.ts`, `consolidate-service.ts`, `context-service.ts` | 단기 관찰에서 기억을 정리·주입하는 경로. 수집 누락이 없다는 보장은 아님 |
| 검색 | `src/services/search-service.ts`, `embeddings-service.ts`, `scripts/benchmarks/retrieval/` | 키워드·선택적 의미 검색과 평가 도구 |
| 연동 | `src/adapters/`, `src/services/hook-service.ts`, `src/mcp/server.ts` | 여러 어댑터와 MCP 구현. 현재 외부 CLI 호환성은 별도 |
| 공유와 계정 경계 | `src/services/sync-service.ts`, `personal-sync-service.ts`, `workspace-service.ts`, `src/storage/account-migration.ts` | 로컬·원격 이벤트 공유와 계정 구분. 열린 이슈를 모두 해결했다는 뜻은 아님 |
| 검증 | `tests/unit/`, `tests/integration/`, `tests/golden/`, `scripts/validate/` | 코드·계약·설치·패키징 검증. 일반적인 기억 효과 입증과 구분 |

## 종료 전 CI 근거

[CI 29632255207](https://github.com/shakystar/memorize/actions/runs/29632255207), 위 기준 커밋에서 실행.

| 작업 | 결과 |
| --- | --- |
| 타입 검사·린트 | 성공 |
| Linux·macOS 단위·통합·golden 테스트 | 성공 |
| Linux·Windows 빌드·패키징 검사 | 성공 |
| Windows 단위 테스트 | 633 통과·2 건너뜀 |
| Windows smoke | 4 통과 |
| Windows 통합 테스트 | 478 통과·1 실패·1 건너뜀 |
| Windows golden | 앞 단계 실패로 실행되지 않음 |

Windows 실패는 `tests/integration/release-packaging.test.ts`의 publish tarball 제외 항목 검사에서 30초 시간이 초과된 것이다. 제품 결함인지 실행 환경의 지연인지 이번 문서 정리만으로 확정하지 않는다. 마지막 전체 CI가 녹색이었다고 주장하지 않는다. smoke와 integration에 겹치는 테스트가 있으므로 수를 합산하지 않는다.

## 검색 평가의 의미

저장된 `bm25.json`과 `hybrid.json`의 overall은 각 500문항이다. recall@5는 0.966과 0.978이다. hybrid ndcg@10 원값은 0.9244658187이므로 세 자리 반올림은 0.924다.

이것은 LongMemEval-S의 관련 기록 검색 평가다. 다음을 입증하지 않는다.

- 에이전트가 실사용 중 중요한 정보를 빠짐없이 수집한다는 주장
- 질문에 대한 최종 답변 정확도 또는 장기 기억의 일반적 효용
- 서로 다른 하네스에서 측정한 다른 제품보다 우수하다는 주장
- 대회 출품 시점에 이 결과가 이미 확보됐다는 주장

이번 정리에서는 유료 모델·임베딩 API를 호출하거나 기존 결과 파일을 다시 생성하지 않는다.

## 남은 문제와 유지보수 종료

열린 이슈의 상태는 완료의 증거가 아니다. 예를 들어 수집 누락·추출 recall(#99, #159), 결정론적 opt-out(#219), 계정 이동·개인 동기화·writer 경계(#224–#226), 동기화 지연(#185), 로컬 임베더(#162), 그래프 기억(#180)이 논의됐다. 일부 구현이 이후 코드에 존재하므로 이슈 제목만 보고 전부 미구현이라고 분류하지 않는다. 해결 여부를 별도 재검증하지 않은 항목은 미해결·불확실한 기록으로 보존한다.

새 기능, 보안 패치, 정기 업데이트, 외부 CLI 호환성 추적은 계획하지 않는다. MIT 소스 공개는 유지보수나 호스팅 제공 약속이 아니다. 기존 npm 패키지와 외부 서비스의 상태는 GitHub archive와 별개다.

## 이번 종료 정리의 로컬 검증

Node.js 24.19.0, pnpm 10.30.3, Linux에서 lockfile 고정 설치 후 빌드·타입 검사·린트·문서 일관성 검사는 통과했다. 전체 테스트는 916 통과·206 실패·1 건너뜀이었다. 이 호스트에서 tsx CLI의 Unix 소켓(`/tmp/tsx-0/*.pipe`) 생성이 `EPERM`으로 거부되는 실패가 확인됐다. 따라서 이 실행을 전체 통과로 취급하지 않고, 206건 모두를 같은 원인으로 확정하지도 않는다. 테스트나 격리 설정을 완화하지 않았다. 모델 평가·실제 운영 Hub 쓰기는 실행하지 않았다.
