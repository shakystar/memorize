# AI 설치 안내 반복 검증 도구

다음 사용자 요청을 일회용 환경에서 실제 Claude CLI로 반복 실행하고, 설치 결과와 격리 범위 밖 쓰기를 검사한다.

> `claude -p "Follow this guide to set up memorize in this project: https://github.com/shakystar/memorize/blob/main/guides/AI_SETUP.md"`

위 영문은 실제 실험 입력이다. 이 도구는 개발 당시 기록으로 보존하며 이번 종료 정리에서 실행하지 않는다. 모델 호출과 구독 사용량이 발생할 수 있다.

## 회차별 격리

| 대상 | 방법 |
| --- | --- |
| 사용자 저장 경로 | 임시 `HOME`·`USERPROFILE`, Windows의 `APPDATA`·`LOCALAPPDATA` |
| npm 전역 설치 | 회차별 `npm_config_prefix`, 다운로드 캐시는 공유 |
| 실행 경로 | node/npm/npx/git/claude/pnpm만 노출하는 shim, 기존 memorize 미탐지 확인 |
| Claude 설정 | 별도 `CLAUDE_CONFIG_DIR`에 인증 파일만 복사하고 개인 훅은 제외 |
| 범위 밖 쓰기 | 실제 Claude·Codex 설정, 실제 기억 저장소, Windows 사용자 환경 변수의 전후 비교 |

범위 밖 변경은 단순 로그가 아니라 실패 근거로 기록한다.

## 시나리오

- `node-basic`: package.json이 있는 기본 프로젝트
- `non-node`: package.json이 없는 전역 설치 경로
- `pnpm-monorepo`: workspace 루트 설치 경로. pnpm이 없으면 건너뜀
- `existing-docs`: 기존 CLAUDE.md·.cursorrules에서 맥락을 가져오는 경로

기본 `mixed`는 앞 절반을 `node-basic`, 나머지를 시나리오 순환으로 실행한다.

## 실행

Node.js 22.9 이상, git, 로그인된 Claude CLI가 필요하다. 내부 세션은 격리 환경에서 `--dangerously-skip-permissions`를 사용한다.

```powershell
# 자체 검사: Claude를 호출하지 않으므로 설치 검증 실패가 예상됨
powershell -ExecutionPolicy Bypass -File run-stress.ps1 -Total 1 -SkipClaude
powershell -ExecutionPolicy Bypass -File run-stress.ps1 -Total 3
powershell -ExecutionPolicy Bypass -File run-stress.ps1 -Total 100 -Mix mixed
```

```bash
bash run-stress.sh --total 1 --skip-claude
bash run-stress.sh --total 100 --mix mixed
```

결과는 저장소 밖 `%LOCALAPPDATA%\memorize-stress` 또는 `~/memorize-stress`에 둔다. 저장소 안에서 실행하면 npx가 npm 배포물 대신 로컬 workspace를 찾을 수 있기 때문이다.

```powershell
node aggregate.mjs "$env:LOCALAPPDATA\memorize-stress\results\win" "\\wsl$\Ubuntu\home\<user>\memorize-stress\results"
```

`meta.json`이 있는 회차는 건너뛰며 `-StartAt`으로 재개 지점을 지정할 수 있다.

## 결과와 한계

각 `results/<platform>/run-NNN/`에는 전체 내부 대화 `stdout.ndjson`, 설치 검사 `verify.json`, 범위 밖 변경 `leak.json`·`leak.diff`, 종료 코드·시간·재시도 `meta.json`을 남긴다. 이 자료에는 실제 세션 내용이 포함될 수 있으므로 공개용 결과와 구분한다.

직렬 실행이며 개발 당시 예상 100회 소요 시간은 4–8시간이었다. 속도 제한 시 `-RateLimitWaitMin`(기본 20분) 뒤 재시도하고 회차별 `-TimeoutMin`(기본 15분) 초과 시 프로세스 트리를 종료한다. Windows 실행 파일이 WSL의 `/mnt/c` PATH를 통해 섞이는 시나리오는 미검증 범위다.
