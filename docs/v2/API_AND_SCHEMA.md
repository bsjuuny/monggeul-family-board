# API 명세·DB 스키마 (v2)

모든 API는 같은 출처 `/api/*`. JSON 본문은 `Content-Type: application/json`, 최대 2MB. 오류 형식 `{"error":{"code","message"}, ...}`.
Origin 헤더가 있으면 같은 호스트 또는 사설·루프백·`.local` 만 허용(공인 도메인 403). CORS 헤더 없음.

인증 종류
- **성인 세션**: `mgfb_session` 쿠키(HttpOnly, SameSite=Strict, 12시간, 쓰는 동안 연장, 최대 30일)
- **TV 기기**: `mgfb_device` 쿠키(HttpOnly, SameSite=Strict, 브라우저 최대 400일, 서버는 마지막 사용 후 180일 만료). **표에 "TV"가 있는 API만** 허용
- owner 전용 표시가 있는 것은 owner 역할만

## 1. 엔드포인트

| 메서드 · 경로 | 인증 | 설명 |
|---|---|---|
| GET /api/health | 없음 | `{status, schemaVersion, serverTime}` |
| POST /api/login · /api/logout · GET /api/me | (v1) | 성인 로그인 |
| GET·PUT /api/state, GET /api/backup, POST /api/restore | 성인(백업·복원 owner) | v1 가족 문서(버전 충돌 409) |
| GET /api/settings | 성인 | `{location, commute, screen, notices, kidsnote, weatherKeyConfigured, _versions}` |
| PUT /api/settings/{location\|commute\|screen\|notices\|kidsnote} | 성인(notices·kidsnote는 owner) | `{value, baseVersion}` → 409 VERSION_CONFLICT |
| POST /api/devices/pairing-codes | 성인 | 6자리 코드, 10분, 동시에 5개까지 |
| POST /api/devices/pair | 없음(IP 속도 제한 10회/10분) | `{code, label}` → 기기 쿠키 발급 |
| GET /api/devices · DELETE /api/devices/{id} | 성인 | 목록·연결 해제 |
| GET /api/device/me · POST /api/device/unpair | TV | 기기 정보·스스로 해제 |
| GET /api/board | 성인·**TV** | 보드 전체(아래 2절) |
| GET /api/weather | 성인·**TV** | 날씨 스냅샷 |
| GET /api/notices?status= | 성인 | 공지 목록(최대 300) |
| POST /api/notices | 성인 | 새 공지 `{source:'manual'\|'gongjitalk', sourceId?, receivedOn, contentHash, digest, originalText?}` → 201, 중복이면 200 `{duplicate:true}` |
| POST /api/notices/import | 성인 | `{items, preview}` 미리보기/저장, 항목별 new·created·duplicate·invalid |
| GET /api/notices/pending-analysis | 성인 | 서버에서 분석하지 못한 공지 원문(브라우저가 분석) |
| GET·PUT·DELETE /api/notices/{id} | 성인 | `?original=1` 원문 포함 / 수정 `{baseVersion, digest}`(보호자 수정 = 확인함) / 삭제(원문도 지움) |
| POST /api/notices/{id}/confirm | 성인 | `{baseVersion, dismiss?}` 확인 또는 숨김 |
| POST /api/notices/{id}/analysis | 성인 | 분석 대기 공지에 요약 채우기 |
| GET /api/notices/{id}/history | 성인 | 수정·삭제 이력 |
| GET·POST /api/preparations, PATCH /api/preparations/{id} | 성인 | 준비물(기간 최대 62일) / 직접 추가 / `{done, text, date, kind, deleted}` |
| GET /api/commute?from&to | 성인 | 설정 + 예외 + 날짜별 계획 |
| POST /api/commute/exceptions · DELETE …/{id} | 성인 | 휴원·등원/하원 시간 변경 직접 입력 |
| GET·PUT /api/pickups | 성인 | 날짜별 담당자·완료 |
| GET /api/notice-events, PUT /api/notice-events/{id}/link | 성인 | 공지 행사 ↔ 캘린더 일정 연결 |
| GET /api/kidsnote/status · POST /api/kidsnote/sync · POST /api/kidsnote/resume | 성인 | 공지 자동 수집 상태·수동 실행(1분 간격)·일시정지 해제 |

## 2. GET /api/board 응답 요약

`serverTime, today, tomorrow, family{name,timezone}, viewer{kind,label,role}, screen{morningFrom,afternoonFrom,eveningFrom,mode},
children[{id,displayName,avatarKey,habits}], commute{configured,today[],tomorrow[]}, weather, notices{needsReview,top[5]},
prep{today[],tomorrow[]}, pickups[], events{today[],tomorrow[]}, tasks{todo,shopping}, sync{name,mode,available,enabled,lastOkAt,lastError,paused}`
- events는 가족 문서의 `visibility:'family'` 일정 + 공지 행사만. 나만 보기 일정은 넣지 않는다.
- 공지는 제목·상태·확인 이유·행사일만. 원문은 넣지 않는다.

## 3. 공지 요약(digest) v1

`title, summary, kinds[], eventDate, eventEndDate, eventTime, dateConfidence(exact|relative|inferred|unknown), dates[], supplies[{text,date,for}],
clothing[], documents[{text,date(기한)}], parentTasks[], fees[], dropoffChange, pickupChange{date,time,text,early}, closure{date,endDate},
needsReply, replyText, needsConfirmation[], cautions[], confidence` — 서버 `board_store.clean_digest` 가 검증·길이 제한한다.

**확인 필요(needs_review) 판정**(서버 `review_reasons`): 등원/하원 시간 변경, 휴원, 제출·동의, 비용 납부, 기한, 날짜 확신 낮음(요일 불일치·요일만·서로 다른 날짜 표현). 그 밖은 `auto`(보드에 바로 표시). 확인 전 파생 항목은 `needsReview=true` 로 보드에 "확인 필요"가 붙는다.

## 4. DB 스키마

v1(유지): `schema_meta, users, sessions, family_doc(1행), doc_backups, audit_log`
v2(추가, `tablet_server/migrations.py`):

| 테이블 | 핵심 열 | 비고 |
|---|---|---|
| devices | id, label, mode='tv', token_hash, last_seen_at, expires_at, revoked_at | 토큰 원문은 저장 안 함 |
| pairing_codes | code_hash, created_by, expires_at, used_at | 1회용, 10분 |
| settings | key, value(JSON), version | 키별 낙관적 잠금 |
| weather_cache | (kind, grid) → base, fetched_at, payload | ncst·fcst |
| notices | id, source, source_id, content_hash, received_on, title, digest, original_text, status, edited_by_user, version, deleted_at | (source, source_id) 유일, 원문은 설정 시만 |
| notice_history | notice_id, at, actor, action, snapshot | |
| prep_items | item_key(유일), notice_id, date, kind, text, needs_review, user_edited, done_at/by | 같은 항목은 같은 key → 다시 수집·수정해도 완료 상태 유지 |
| commute_exceptions | item_key, notice_id, date, end_date, kind(closed\|dropoff_time\|pickup_time), time, needs_review | |
| notice_events | item_key, notice_id, date, time, title, calendar_event_id, calendar_snapshot | 캘린더 연결 |
| pickups | (date, child_id) → assignee, done_at/by | |
| sync_state · sync_runs | 수집 커서·실패 횟수·백오프·일시정지 / 실행 기록 | |

마이그레이션: 적용 전 DB 파일 백업 → 버전별 한 트랜잭션 → 실패 시 롤백(DB 변경 없음). `--migrate-dry-run`, `--restore-db` 제공.
