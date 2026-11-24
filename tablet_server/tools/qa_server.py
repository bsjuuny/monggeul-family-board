"""화면 QA 전용 서버: 임시 DB에 예시 가족·아이·일정·공지·설정을 넣고, 가짜 날씨로 dist를 서빙한다.

외부 네트워크를 쓰지 않는다(기상청은 가짜 응답). 운영 DB·운영 서버와 무관하다.
    python tablet_server/tools/qa_server.py [--port 4174] [--empty]
계정: owner / qa-owner-pass,  mom / qa-mom-pass-1
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402
import board_store as bs  # noqa: E402
import radio  # noqa: E402
from analyzer_bridge import NodeAnalyzer  # noqa: E402

KST = timezone(timedelta(hours=9))


def fake_kma(key: str):
    def fetch(op, params):
        bd, bt = params["base_date"], params["base_time"]
        if op == "getUltraSrtNcst":
            items = [{"category": "T1H", "obsrValue": "3.2"}, {"category": "PTY", "obsrValue": "0"},
                     {"category": "WSD", "obsrValue": "2.4"}, {"category": "REH", "obsrValue": "45"}]
        else:
            start = datetime.strptime(bd + bt, "%Y%m%d%H%M")
            items = []
            for i in range(1, 60):
                t = start + timedelta(hours=i)
                h = t.hour
                tmp = round(1 + 9 * max(0.0, 1 - abs(h - 14) / 9), 1)  # 새벽 1도 ~ 오후 2시 10도
                pop = 70 if (t.date() > start.date() and 6 <= h <= 11) else 20
                pty = "1" if pop >= 70 else "0"
                for cat, val in (("TMP", tmp), ("POP", pop), ("PTY", pty), ("SKY", "1" if pop < 60 else "4"), ("WSD", "3.5"), ("REH", "50")):
                    items.append({"fcstDate": t.strftime("%Y%m%d"), "fcstTime": t.strftime("%H00"), "category": cat, "fcstValue": str(val)})
        return {"response": {"header": {"resultCode": "00"}, "body": {"items": {"item": items}}}}
    return fetch


QA_RADIO_KEY = "qa-radio-pass"
_radio_state = {"station": None}


def fake_radio(url, headers, timeout):
    """가짜 radio-cast(미니PC·스피커 없이 화면 QA). 진짜 스피커로는 아무것도 보내지 않는다."""
    if headers.get("X-Radio-Key") != QA_RADIO_KEY:
        return 401, {"ok": False, "auth": "need"}
    path = url.split(":8765", 1)[1]
    names = {"cbs_music": "CBS 음악FM", "cbs_std": "CBS 표준FM", "kbs_cool": "KBS 쿨FM", "kbs_classic": "KBS 클래식FM", "kbs_1radio": "KBS 1라디오",
             "kbs_happy": "KBS 해피FM", "mbc_fm4u": "MBC FM4U", "mbc_std": "MBC 표준FM", "mbc_allthat": "MBC 올댓뮤직",
             "sbs_power": "SBS 파워FM", "sbs_love": "SBS 러브FM", "ebs_fm": "EBS FM"}  # 실제 radio-cast 12개 채널과 같게
    if path.startswith("/api/stations"):
        return 200, [{"id": k, "group": v.split()[0], "name": v.split()[1]} for k, v in names.items()]
    if path.startswith("/api/devices"):
        return 200, {"default": "주방", "devices": [{"name": "주방", "model": "Google Nest Hub"}, {"name": "LRoom-speaker", "model": "Google Nest Audio"}]}
    if path.startswith("/play"):
        sid = path.split("station=", 1)[1].split("&", 1)[0]
        _radio_state["station"] = sid
        return 200, {"ok": True, "device": "주방", "station": sid, "title": names.get(sid, sid)}
    if path.startswith("/stop"):
        _radio_state["station"] = None
        return 200, {"ok": True, "device": "주방"}
    if path.startswith("/volume"):
        return 200, {"ok": True, "device": "주방", "volume": 0.35}
    if path.startswith("/status"):
        sid = _radio_state["station"]
        return 200, {"ok": True, "device": "주방", "state": "PLAYING" if sid else None, "station": sid, "title": names.get(sid) if sid else None, "volume": 0.3}
    if path.startswith("/stream"):
        return 200, {"ok": True, "station": "cbs_music", "title": "CBS 음악FM", "url": "https://qa.invalid/live.m3u8"}
    return 404, {"ok": False}


def seed(db: Path) -> None:
    today = datetime.now(KST).date().isoformat()
    tomorrow = bs.add_days(today, 1)
    doc = {
        "v": 1,
        "users": [{"id": "u-owner", "email": "owner"}, {"id": "u-mom", "email": "mom"}],
        "otp": {}, "secrets": [], "invitations": [], "pairing": [], "devices": [], "unlocks": [], "idempotency": [], "audit": [], "failures": {},
        "families": [{"id": "f1", "name": "몽글네", "timezone": "Asia/Seoul", "createdAt": "2026-11-01T00:00:00Z"}],
        "members": [{"familyId": "f1", "userId": "u-owner", "role": "owner", "displayName": "아빠"},
                    {"familyId": "f1", "userId": "u-mom", "role": "adult", "displayName": "엄마"}],
        "children": [{"familyId": "f1", "id": "c1", "displayName": "서윤", "avatarKey": "bodeuli", "active": True}],
        "events": [
            {"id": "e1", "familyId": "f1", "createdBy": "u-owner", "title": "할머니 댁 저녁", "allDay": False, "startDate": None, "endDate": None,
             "startsAt": f"{today}T10:00:00Z", "endsAt": f"{today}T12:00:00Z", "visibility": "family", "note": None, "version": 1,
             "createdAt": "2026-11-01T00:00:00Z", "updatedAt": "2026-11-01T00:00:00Z"},
            {"id": "e2", "familyId": "f1", "createdBy": "u-owner", "title": "깜짝 선물 준비", "allDay": True, "startDate": today, "endDate": today,
             "startsAt": None, "endsAt": None, "visibility": "private", "note": None, "version": 1, "createdAt": "2026-11-01T00:00:00Z", "updatedAt": "2026-11-01T00:00:00Z"},
        ],
        "tasks": [], "habitTemplates": [], "habitRecords": [],
    }
    conn = app.connect(db)
    conn.execute("UPDATE family_doc SET version = 1, data = ? WHERE id = 1", (json.dumps(doc, ensure_ascii=False),))
    conn.close()
    conn = app.connect(db)
    bs.put_setting(conn, "location", {"name": "우리 동네", "lat": 37.5665, "lon": 126.978}, 0, "qa")
    bs.put_setting(conn, "radio", {"baseUrl": "http://192.168.0.130:8765", "defaultDevice": "주방"}, 0, "qa")
    radio.save_key(db.parent, QA_RADIO_KEY)
    bs.put_setting(conn, "commute", {"children": {"c1": {"weekdays": [1, 2, 3, 4, 5, 6, 7], "leaveHomeAt": "08:30", "arriveBy": "09:00", "pickupAt": "16:30",
                                                          "pickupAssignee": "엄마", "pickupAtByWeekday": {}, "pickupAssigneeByWeekday": {}}}}, 0, "qa")
    texts = [
        (f"내일 숲 체험이 있습니다. 활동하기 편한 복장과 운동화를 착용해 주세요. 개인 물통과 여벌옷을 보내주세요. 우천 시 실내 활동으로 대체됩니다.", today),
        (f"{int(tomorrow[5:7])}월 {int(tomorrow[8:])}일 교사 연수로 오후 1시에 조기 하원합니다. 참석 여부를 내일까지 문자로 알려주세요.", today),
        ("사진 촬영 동의서를 다음 주 월요일까지 제출해 주세요.", today),
    ]
    res = NodeAnalyzer().analyze([{"text": t, "receivedOn": r} for t, r in texts])
    for (t, r), out in zip(texts, res):
        bs.create_notice(conn, {"source": "manual", "receivedOn": r, "contentHash": out["contentHash"], "digest": out["digest"]}, "qa")
    conn.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=4174)
    ap.add_argument("--empty", action="store_true", help="예시 데이터 없이(빈 상태 화면 확인)")
    args = ap.parse_args()
    os.environ["MGFB_KMA_KEY"] = "qa-fake-key"
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        db = Path(tmp) / "qa.sqlite3"
        config = app.Config(db_path=db, dist_dir=app.DEFAULT_DIST_DIR, login_max_failures=1000, login_ip_max_failures=1000, weather_fetcher=fake_kma, radio_fetcher=fake_radio)
        server = app.make_server(config, "127.0.0.1", args.port)
        app.create_user(db, "owner", "qa-owner-pass", "owner")
        app.create_user(db, "mom", "qa-mom-pass-1", "adult")
        if not args.empty:
            seed(db)
        print(f"QA server on http://127.0.0.1:{args.port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
