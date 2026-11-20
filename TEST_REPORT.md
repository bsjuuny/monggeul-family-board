# 검증 보고서

> v2 검증 결과는 [docs/v2/V2_REPORT.md](docs/v2/V2_REPORT.md) 5절(2026-11-20). 아래는 v1 기록이다.

검증일: 2026-11-19 (Windows 로컬)

| 항목 | 상태 | 결과 |
|---|---|---|
| TypeScript typecheck | PASS | `npm run typecheck` |
| Vitest | PASS | 2 files, 32 tests |
| Python 서버 unittest | PASS | 34 tests |
| Production build | PASS | Vite 99 modules, sourcemap 비활성 |
| 실제 Python/SQLite Playwright | PASS | 30 passed, 6 viewport 중복 시나리오 skipped |
| 화면 크기 | PASS | 360×800, 768×1024, 1024×900, 1920×1080 |
| Android Termux 실기기 | UNVERIFIED | 실제 태블릿 설치·절전·공유기 DHCP 예약은 사용자 환경에서 확인 필요 |

## 확인한 주요 시나리오

- ID/비밀번호 로그인, 실패 안내, 로그아웃 후 서버 세션 폐기
- 가족 생성과 주요 화면 탐색
- SQLite 저장 후 새로고침·다른 브라우저 재접속
- 서버 부재 시 조용한 브라우저 로컬 저장 fallback 금지
- 동일 baseVersion 동시 쓰기에서 한 요청만 성공하고 다른 요청은 409
- 충돌 시 편집 입력 보존, 서버 문서 미덮어쓰기, 내 JSON 백업
- owner JSON 백업·복원 및 adult 권한 거부
- PBKDF2 310,000회, 세션 token 해시 저장, 12시간 쿠키
- `HttpOnly; SameSite=Strict`, HTTP LAN용 `Secure` 미사용
- 2MB 본문 제한, 로그인 속도 제한, origin 검사, 정적 MIME/CSP
- SQLite 요청별 연결, WAL, 5초 busy timeout

실제 Android/Termux 환경만 이 작업 환경에서 확인할 수 없어 `UNVERIFIED`로 남겼습니다.
