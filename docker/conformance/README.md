# Docker 기반 에이전트 연동 검증

**동결된 수동 검증 도구다.** 개발 당시 Claude Code 이외의 Codex·opencode·Gemini CLI·pi·Hermes·Cursor 연동은 CI 보장에서 제외됐고 `harness-conformance.yml`도 제거됐다. 현재는 전체 프로젝트의 유지보수가 종료됐다. 아래 결과는 당시 기록이며 현재 CLI 버전과의 호환성을 뜻하지 않는다.

실제 에이전트 CLI에 Memorize를 설치해 훅·플러그인·MCP 연결과 수집 동작을 검증한다. Docker 이미지가 이 저장소를 빌드한 후 `npm i -g .`로 설치하므로, 설치되는 훅은 npm의 다른 배포물이 아닌 해당 빌드를 호출한다.

## 검증 단계

| 단계 | 검사 | 모델 호출 |
| --- | --- | --- |
| A | 실제 CLI 설치 후 `memorize init`, MCP·훅·작업 규칙 파일 확인 | 없음 |
| A′ | 플러그인 로드·기동 오류 확인 | 원칙적으로 없음, 가능한 CLI만 |
| A″ | 설치된 명령과 합성 도구 입력을 통해 수집·주입 확인 | 없음 |
| B | 실제 프롬프트로 파일 수정을 유도하고 기억 수집 확인 | 인증 키 필요, 비결정적 |
| C | Cursor의 공개 훅 문서에 기대하는 계약 이름이 남아 있는지 검사 | 모델 없음, 네트워크 필요 |

A는 필수 실패 기준이다. 선택 단계는 실제 실행됐을 때 그 결과를 판정한다. 자동 실행 일정은 남아 있지 않다.

## 실행

저장소 루트에서 실행한다.

```sh
docker build -f docker/conformance/Dockerfile -t memorize-conformance .
# 모델을 호출하지 않는 검증
docker run --rm memorize-conformance opencode
# 실제 모델 검증: 호출 비용과 인증 설정을 별도로 확인
docker run --rm -e OPENCODE_CONFORMANCE_LIVE=1 -e OPENAI_API_KEY=… \
  memorize-conformance opencode
```

## 확장 시 계약

`harnesses/<id>.sh`는 `install_harness`, `assert_artifacts`를 정의하고, 선택적으로 `plugin_load_check`, `live_capture_check`를 구현한다. `run.sh`가 공통 단계를 실행하며 ID는 `src/harness/registry.ts`에도 있어야 한다.

## 보존된 검증 상태

- **opencode 1.17.11**: 당시 A·A′·A″·B에서 PASS=9. 실제 `write`→`Write`, `edit`→`Edit` 수집과 `read` 제외를 확인했다. `tool.execute.after` 입력은 `{ tool, sessionID, callID, args:{ filePath, content|oldString/newString }}`였다. `bash` 실제 호출과 `experimental.session.compacting` 종단 간 경로는 미검증이었다. B는 당시 Anthropic haiku를 사용했으며 `OPENCODE_MODEL`과 대응 키로 바꿀 수 있다.
- **Hermes**: 합성 입력 중심. 기본 설치 감지는 임시 `~/.hermes`로 대체하며 실제 CLI는 `HERMES_CONFORMANCE_LIVE=1`일 때만 설치한다. `write_file`·`patch`, `terminal`, `pre_llm_call`의 `{"context": …}` 주입과 세션별 1회 주입 경계를 검사했다. 실제 CLI 기동·Nous 모델 호출과 외부 설정 변경 추적은 보장하지 않는다.
- **Cursor**: 프로젝트별 `.cursor/hooks.json`, `.cursor/mcp.json`, AGENTS.md를 검사한다. 합성 단계는 생성된 훅 명령을 그대로 실행해 `Write`·`Shell` 수집과 `{"additional_context": …}` 주입을 확인한다. 실제 `cursor-agent -p` 단계에는 `CURSOR_API_KEY`가 필요하다. 공개 문서 검사에서는 `sessionStart`, `postToolUse`, `preCompact`, `sessionEnd`, 입력·출력 필드 이름을 확인한다. 로컬 CLI와 클라우드 에이전트의 세션 수명주기 차이를 검증 완료로 가정하지 않는다.

현재 상태와 전체 검증 한계는 [최종 상태](../../docs/final-status.md)를 참고한다.
