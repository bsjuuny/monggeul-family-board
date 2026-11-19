# 태블릿 LAN 서버 아키텍처

## 데이터 경계

브라우저는 현재 주소의 `/api/*`만 호출합니다. 가족 문서는 브라우저 `localStorage`나 외부 클라우드가
아니라 태블릿의 SQLite `family_doc` 한 행에 JSON으로 저장됩니다. 서버가 없는 경우 로컬 저장소로
자동 전환하지 않습니다.

```text
같은 Wi-Fi의 브라우저
        │ HTTP + HttpOnly 세션 쿠키
        ▼
Android 태블릿 / Termux / Python ThreadingHTTPServer
        │ 요청별 SQLite 연결, WAL, busy_timeout=5000
        ▼
$HOME/monggeul-family-board-data/family.sqlite3
```

## 쓰기 규칙

클라이언트는 마지막으로 읽은 `baseVersion`과 전체 가족 JSON 문서를 보냅니다. 서버 version이 같을
때만 원자적으로 version을 1 올려 저장합니다. 다르면 `409`를 반환하므로 늦은 기기가 다른 기기의
변경을 덮어쓰지 않습니다.

## 인증

- 계정 비밀번호: 사용자별 salt와 PBKDF2-HMAC-SHA256 310,000회
- 세션: 원문 대신 SHA-256 해시를 DB에 저장, 12시간 만료
- 쿠키: `HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`
- 같은 Wi-Fi의 평문 HTTP 동작을 위해 `Secure`는 붙이지 않습니다.
- 로그인 실패는 ID/IP 기준 메모리 속도 제한을 적용합니다.

## 운영 경계

이 서버는 신뢰하는 가정용 LAN 전용입니다. Termux wake lock과 Android 배터리 최적화 해제,
공유기 DHCP 예약을 권장합니다. WAN 포트포워딩이나 인터넷 공개는 지원 범위가 아닙니다.
