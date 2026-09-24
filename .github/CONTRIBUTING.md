# 소스 검증·포크 안내

Memorize는 개발을 종료하고 기록을 보존하는 저장소다. 신규 이슈·PR 검토나 유지보수를 약속하지 않는다. 현재 소스는 [MIT 라이선스](../LICENSE)에 따라 포크·수정할 수 있다.

## 재현 명령

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm qa:quick
pnpm check
```

테스트는 임시 `MEMORIZE_ROOT`를 사용한다. 실제 개인 기억 저장소에 테스트를 실행하지 않는다. 구현 기준·기존 CI 실패와 검증 한계는 [최종 상태](../docs/final-status.md)를 참고한다.

## 보존한 설계 원칙

이벤트 로그를 원본으로 두며 과거 이벤트를 제자리에서 수정하지 않는다. 어댑터·도메인·서비스·저장 계층의 경계를 유지한다. 포크에서 동작을 바꾼다면 해당 동작의 회귀 검증과 변경 근거를 함께 남기는 것을 권장한다.

## 릴리스 종료

종료 문서 정리로 새 npm 버전을 발행하지 않는다. 기존 자동 릴리스 정의는 [실행되지 않는 보관 파일](../docs/archive/release-workflow.yml.disabled)로 옮겼다. 기존 버전·태그·CHANGELOG와 npm 배포물은 보존한다.
