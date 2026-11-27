# 운영·배포·백업·복구 (v2)

대상: 거실 Android 태블릿(Termux)에서 도는 태블릿 서버. 같은 Wi-Fi 전용, HTTP, 포트 8787.

## 1. 태블릿 배포와 되돌리기 (운영 DB 보존)

운영 태블릿의 Termux에서 직접 실행한다. 단계가 실패하면 다음 단계로 넘어가지 않는다.

1. 현재 서버가 수동 실행인지 Termux:Boot인지 확인한다. 수동이면 서버가 열린 터미널에서 종료한다. 자동이면 **재시작 루프를 먼저 중지한 다음** 해당 Python 서버만 멈춘다. Python만 종료하면 약 10초 후 자동으로 다시 뜬다.
2. 기존 체크아웃의 브랜치와 커밋을 확인한다. `git status --short`에 변경이 있거나 실행 중인 서버의 DB 경로(`--db` / `MGFB_DB`)가 확인되지 않으면 중단한다. `main`은 이미 v2이므로 v1 복구 기준이 아니다.
3. 현재 빌드와 SQLite를 같은 백업 폴더에 보관한다. 아래의 `db`는 기본값이므로 실제 경로가 다른 경우 먼저 수정한다. SQLite 온라인 백업을 사용해 WAL에 반영된 데이터도 포함한다. 백업은 Git 저장소 밖에 보관한다.

```sh
cd "$HOME/monggeul-family-board"
umask 077
db="$HOME/monggeul-family-board-data/family.sqlite3"
backup="$HOME/monggeul-family-board-data/manual-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$(dirname "$backup")" && mkdir "$backup" &&
  git rev-parse HEAD > "$backup/commit.txt" &&
  git branch --show-current > "$backup/branch.txt" &&
  cp -a dist "$backup/" && { [ ! -d dist-server ] || cp -a dist-server "$backup/"; } &&
  python - "$db" "$backup/family.sqlite3" <<'PY'
import sqlite3, sys
from contextlib import closing
from pathlib import Path
src, dst = map(Path, sys.argv[1:])
with closing(sqlite3.connect(src.resolve().as_uri() + '?mode=ro', uri=True)) as inp:
    with closing(sqlite3.connect(dst)) as out:
        inp.backup(out)
        assert out.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
PY
```

4. `git fetch origin` 후 **배포 승인된 커밋**과 현재 커밋을 확인하고, `git merge --ff-only <배포커밋>`으로 반영한다. fast-forward가 실패하면 강제 덮어쓰지 않는다. 태블릿에서는 `npx vite build`로 화면을 빌드한다(`npm run build`는 타입 검사·분석기 빌드까지 돌리므로 PC에서 쓴다). 공지 분석 코드(`src/notices/`)가 바뀐 커밋이면 `npx vite build --config vite.analyzer.config.ts`로 분석기(`dist-server/analyze.mjs`)도 다시 만든다. 의존성(`package-lock.json`)이 바뀐 경우에만 먼저 `npm ci`를 한다.
5. v1에서 처음 올라가는 경우만 같은 DB 경로를 지정해 `python tablet_server/app.py --db "$db" --migrate-dry-run`을 실행한다. 기존 행 수 유지와 `integrity_check=ok`를 확인한다. 서버 시작 시 실제 마이그레이션이 적용되며, 마이그레이션 직전 백업도 자동으로 생성된다.
6. 기존 실행 방식으로 서버를 다시 띄운다. 휴대폰·TV에서 새로고침한 뒤 기존 가족 데이터, 공지 상세의 날짜와 시간을 확인한다.

### 실패하면

- 서버와 자동 재시작 루프를 다시 멈춘다. 현재 상태도 따로 보관한 뒤, 위 백업의 `commit.txt`에 있는 **원래 커밋**과 보관한 `dist/`, `dist-server/`로 복구한다. 브랜치 이름 대신 실제 커밋을 쓴다.
- DB 스키마가 그대로라면 DB는 복원하지 않는다. v1→v2 전환을 되돌리는 등 DB 복원이 꼭 필요한 경우에만, 전환 이후 추가된 데이터가 사라질 수 있음을 확인하고 복원한다. 기존 DB는 `--restore-db`가 `family.sqlite3.before-restore-<시각>`으로 보관한다.
- 복구 후 원래 실행 방식으로 서버를 띄우고 기존 데이터가 표시되는지 확인한다.


## 2. v2 처음 설정 순서

1. 보호자 휴대폰으로 `http://<태블릿 IP>:8787` 접속·로그인
2. **설정 → 날씨 지역**: 동네 선택(또는 위도·경도)
3. 기상청 키 저장: **태블릿에서 직접** 브라우저로 `http://127.0.0.1:8787` 을 열고 owner로 로그인 → 설정 → 날씨 지역 → 기상청 서비스 키에 붙여넣고 "확인하고 저장". 키가 Wi-Fi로 오가지 않게 다른 기기에서는 입력칸이 나오지 않는다. 저장 전에 기상청에 한 번 시험 호출해 틀리거나 확인 못 한 키는 저장하지 않는다. (Termux에서 `python tablet_server/app.py --set-weather-key` 로도 가능)
   - 공공데이터포털 "기상청_단기예보 조회서비스" 활용 신청이 된 **Decoding 키**. 키는 `~/monggeul-family-board-data/kma_key.txt`(권한 600)에만 저장되고 로그·화면에 나오지 않는다.
   - 무료 API다. 서버는 10분마다 발표 시각이 바뀌었을 때만 부른다(하루 약 30~40회).
4. **설정 → 등하원 시간**: 아이별 요일·집 출발·도착·하원·기본 픽업 담당
5. **설정 → TV 연결**: 코드 만들기 → 거실 TV 브라우저에서 `http://<태블릿 IP>:8787/#/display` → 코드 입력
6. (선택) 공지톡 정리함(Cafe24) 저장함 → **내보내기** → 보드 **공지 정리 → 공지톡에서 가져오기**
   - 공지톡 내보내기 버튼은 gongjitalk `feat/export-json` 브랜치에 있고 아직 Cafe24에 배포하지 않았다(배포는 사용자 승인 후).

## 3. 상시 운영

- **재부팅 후 자동 시작**: Termux:Boot 설치 후 `scripts/termux-boot.sh` 를 `~/.termux/boot/` 에 복사(스크립트 머리말 참고). wake lock, 서버 자동 재시작(10초), 로그 5MB 회전.
- Android 설정: Termux·Termux:Boot 배터리 최적화 해제, 공유기 DHCP 예약으로 태블릿 IP 고정.
- **TV 인증**: TV는 기기 토큰(HttpOnly 쿠키, 사용 중이면 계속 연장, 180일 미사용 시 만료). 성인 세션은 쓰는 동안 12시간씩 연장, 최대 30일.
- **네트워크 단절**: 보드는 마지막으로 받은 정보를 그대로 보여 주고 "오프라인" 띠를 띄운다. 날씨 갱신이 실패하면 마지막 정상 값을 "오래된 날씨 · HH:MM 기준" 으로 표시한다.
- **앱 업데이트**: 새 빌드를 올리면 서비스 워커 캐시 이름이 바뀐다. 보드·TV 화면은 1시간 안에 새 버전을 받아 자동 새로고침, 다른 화면은 보드로 돌아갈 때 새로고침.

## 4. 백업·복구

| 종류 | 위치 | 언제 |
|---|---|---|
| 가족 문서 JSON 백업 | 설정 → 서버와 백업 (owner) | 사람이 내려받음 |
| 복원 직전 자동 백업 | 가족 문서: SQLite `doc_backups`(최근 20개) / DB 파일: `backups/pre-restore-*`(최근 10개) | JSON 복원 때 |
| 마이그레이션 전 DB 파일 | `~/monggeul-family-board-data/backups/pre-migrate-*`(최근 10개) | 스키마 업그레이드 때 |
| 수동 DB 파일 사본 | 위 1절 1) | 업그레이드·이전 전 |

JSON 백업(설정 → 서버와 백업, owner) 범위
- 들어감: 가족 문서(일정·할 일·습관·구성원), v2 표 `settings`, `notices`(요약만), `prep_items`, `commute_exceptions`, `notice_events`, `pickups`
- 안 들어감: 공지 원문(개인정보), 공지 수정 이력, TV 기기·연결 코드, 로그인 계정·세션, 날씨 캐시, 수집 기록
- 복원하면 가족 문서와 **백업 파일에 들어 있는 v2 표**를 백업 시점으로 바꾼다(파일에 없는 표는 그대로 둔다). 복원 직전 DB 파일 전체를 `backups/pre-restore-<시각>.sqlite3`로 자동 저장한다(최근 10개).
- 계정·TV 연결까지 통째로 옮기거나 되돌리려면 DB 파일을 복사한다:
  `sqlite3 ~/monggeul-family-board-data/family.sqlite3 ".backup '/sdcard/Download/family-$(date +%F).sqlite3'"` (Termux `pkg install sqlite`, 저장소 권한 `termux-setup-storage` 필요)

## 5. 태블릿 서버 vs 미니PC 서버 비교

| 항목 | Android 태블릿 + Termux (현재) | 미니PC (예: N100, Linux) |
|---|---|---|
| 24시간 안정성 | Android가 백그라운드 앱을 종료할 수 있다. wake lock·배터리 최적화 해제·Termux:Boot로 완화하지만 OS 업데이트·저전력 모드에서 멈출 수 있다 **[실기기 미검증]** | systemd 서비스로 상시 구동이 표준. 재부팅·크래시 후 자동 재시작이 확실하다 |
| 전력 | 화면 끄면 2~4W, 화면을 보드로 켜 두면 5~8W **[추정]** | 6~12W 유휴 **[추정]** + 별도 화면 |
| 절전·백그라운드 종료 | 가장 큰 위험. 제조사별 절전 정책이 다르다 | 해당 없음 |
| 네트워크 유지 | Wi-Fi 절전으로 끊길 수 있음(개발자 옵션 "Wi-Fi 항상 켜기") | 유선 LAN 가능 |
| 재부팅 후 자동 시작 | Termux:Boot 필요(별도 앱) | systemd `enable` |
| DB 백업 | 수동 또는 Termux cron(`pkg install cronie`) | cron + NAS 백업 쉽게 연결(C:\github NAS 계획과 맞음) |
| 보드 화면 겸용 | 서버 = 거실 화면 한 대로 끝 | 화면용 기기가 따로 필요 |
| 유지보수 난이도 | 중간(Termux 패키지·Android 업데이트 영향) | 낮음~중간(일반 Linux) |
| 추가 비용 | 없음 | 미니PC 구매 |

권고: **지금은 태블릿 유지**(지시서대로 운영 서버를 옮기지 않음). 실기기에서 1~2주 동안 "서버 응답 끊김 횟수"를 로그(`server.log`의 종료·재시작 줄)로 보고, 하루 1회 이상 끊기면 미니PC 이전을 검토한다. 코드는 표준 라이브러리 Python이라 미니PC로 옮길 때 바꿀 것은 실행 방법(systemd)뿐이다.
