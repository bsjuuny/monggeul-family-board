# 몽글 패밀리보드

가족 일정, 할 일·장보기, 아이 습관, 읽기 전용 TV 화면을 한곳에서 쓰는 동일 Wi-Fi 전용 가족 보드입니다.

- 화면: React PWA
- 서버: Python 표준 라이브러리 `ThreadingHTTPServer`
- DB: 태블릿 내부 SQLite에 버전이 있는 가족 JSON 문서로 저장
- 인증: ID/비밀번호, 12시간 `HttpOnly; SameSite=Strict` 세션 쿠키
- 외부 서비스: Supabase, RPC, Edge Function, Cafe24가 필요하지 않습니다.

## v2 (동화형 보드)

- 메인 화면 `/`: 큰 시계, 아침·오후·저녁 화면, 등원·하원 카운트다운, 기상청 날씨·옷차림, 공지톡 소식, 준비물
- TV 화면 `/#/display`: 설정 → TV 연결의 6자리 코드로 연결(로그인 없음, 읽기 전용)
- 공지 정리·준비물·픽업 화면, 공지톡 가져오기, 키즈노트 수집 구조(실제 수집은 꺼짐)
- 업그레이드·백업·복구: [docs/v2/OPERATIONS.md](docs/v2/OPERATIONS.md) · 결과 보고서: [docs/v2/V2_REPORT.md](docs/v2/V2_REPORT.md)
- 기상청 키: `python tablet_server/app.py --set-weather-key` · 업그레이드 시험: `--migrate-dry-run` · 되돌리기: `--restore-db <백업>`

## Windows에서 바로 확인

Node.js와 Python 3.9 이상이 필요합니다.

```powershell
cd C:\ai\monggeul-family-board
npm ci
npm run build
python tablet_server\app.py --init-admin owner
python tablet_server\app.py --host 0.0.0.0 --port 8787
```

비밀번호는 명령줄 인수나 로그에 남지 않도록 두 번 묻습니다. 서버를 켠 뒤 PC 브라우저에서
`http://127.0.0.1:8787`을 엽니다. 같은 Wi-Fi의 다른 기기에서는 서버가 표시한
`http://태블릿-IP:8787` 주소를 엽니다.

두 번째 성인 계정은 서버를 끄고 다음처럼 추가합니다.

```powershell
python tablet_server\app.py --add-user mom
```

기본 DB는 사용자 홈의 `monggeul-family-board-data/family.sqlite3`에 있습니다. 테스트용 DB를
따로 쓰려면 `--db`를 지정하세요.

## Android 태블릿에서 운영

1. 최신 Termux를 F-Droid 또는 Termux 공식 GitHub 릴리스에서 설치합니다.
2. Android 설정에서 Termux의 배터리 최적화를 해제합니다.
3. Termux에서 아래 명령을 실행합니다.

```sh
pkg update
pkg install git python nodejs-lts
git clone https://github.com/bsjuuny/monggeul-family-board.git
cd monggeul-family-board
npm ci
npm run build
python tablet_server/app.py --init-admin owner
termux-wake-lock
python tablet_server/app.py --host 0.0.0.0 --port 8787
```

태블릿 IP는 Android의 `설정 > Wi-Fi > 현재 네트워크`에서 확인할 수 있습니다. 공유기의 DHCP
예약 기능으로 태블릿 IP를 고정하면 가족이 항상 같은 주소로 접속할 수 있습니다.

이 구성은 신뢰하는 WPA2/WPA3 가정용 Wi-Fi 안에서만 사용하세요. 공유기의 WAN 포트포워딩,
공인 인터넷 공개, 게스트 Wi-Fi 공개는 하지 마세요. HTTP이므로 네트워크 운영자가 트래픽을 볼 수
있습니다. 외부 접속이 필요해지는 시점에는 HTTPS/VPN이 있는 별도 구성이 필요합니다.

## 백업과 충돌

- 설정의 `JSON 백업 내려받기`와 `JSON 복원`은 owner만 사용할 수 있습니다.
- 복원 직전 서버가 현재 문서를 SQLite 내부 백업으로 보관합니다(최근 20개).
- 다른 기기가 먼저 저장하면 서버는 `409 VERSION_CONFLICT`를 반환하고 기존 문서를 덮어쓰지
  않습니다. 화면의 입력값은 유지되며 `내 JSON 백업`으로 내려받을 수 있습니다.
- 서버에 연결되지 않으면 브라우저 로컬 DB로 조용히 전환하지 않습니다.

## 검증

```powershell
npm run typecheck
npm test
npm run test:server
npm run build
npx playwright install chromium
npm run e2e
```

`npm run e2e`는 임시 SQLite와 임시 계정을 사용하며 실제 운영 DB에는 접근하지 않습니다.
검증 결과는 [TEST_REPORT.md](TEST_REPORT.md)에 기록합니다.

## 주요 경로

- `tablet_server/app.py`: 정적 파일/API/SQLite 서버와 계정 관리 CLI
- `src/server/api.ts`: 동일 출처 API 클라이언트
- `src/repo/serverRepository.ts`: 버전 동기화와 충돌 처리
- `tablet_server/tests/test_server.py`: 서버·보안·동시성 테스트
- `tests/e2e/smoke.spec.ts`: 실제 Python 서버를 사용한 브라우저 시나리오
- `docs/ARCHITECTURE.md`: 데이터 경계와 운영 원칙
