"""v2 서버 기능 테스트: 마이그레이션, 세션 연장, TV 기기, 설정, 공지·파생 항목, 등하원, 날씨, 공지 자동 수집.

외부 네트워크는 쓰지 않는다(기상청·키즈노트는 모두 가짜 객체).
실행: python -m unittest discover -s tablet_server/tests -v
"""
from __future__ import annotations

import hashlib
import http.client
import io
import json
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402
import board_store as bs  # noqa: E402
import kidsnote  # noqa: E402
import migrations  # noqa: E402
import weather  # noqa: E402
from analyzer_bridge import AnalyzerUnavailable, content_hash  # noqa: E402

KST = timezone(timedelta(hours=9))
OWNER_PW = "owner-password-1"
ADULT_PW = "adult-password-1"


class Jar:
    """쿠키 여러 개를 보관하는 브라우저 흉내."""

    def __init__(self, port: int):
        self.port = port
        self.cookies: dict = {}

    def request(self, method, path, body=None):
        h = {}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        if self.cookies:
            h["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            conn.request(method, path, body=data, headers=h)
            res = conn.getresponse()
            payload = res.read()
            for k, v in res.getheaders():
                if k.lower() == "set-cookie":
                    name, val = v.split(";", 1)[0].split("=", 1)
                    if val:
                        self.cookies[name] = val
                    else:
                        self.cookies.pop(name, None)
            body_json = json.loads(payload) if payload and res.getheader("Content-Type", "").startswith("application/json") else None
            return res.status, body_json, dict(res.getheaders())
        finally:
            conn.close()


class FakeAnalyzer:
    """텍스트에 '준비물:' 이 있으면 준비물로, '하원' 이 있으면 하원 변경으로 만든다."""

    def __init__(self, available=True):
        self.ok = available
        self.calls = 0

    def analyze(self, items):
        if not self.ok:
            raise AnalyzerUnavailable("없음")
        self.calls += 1
        out = []
        for it in items:
            text, recv = it["text"], it["receivedOn"]
            tomorrow = (datetime.fromisoformat(recv) + timedelta(days=1)).date().isoformat()
            dg = {"title": text[:20], "summary": "요약", "kinds": [], "dateConfidence": "relative", "eventDate": tomorrow,
                  "supplies": [{"text": "물통", "date": tomorrow, "for": "dropoff"}] if "물통" in text else []}
            if "하원" in text:
                dg["pickupChange"] = {"date": tomorrow, "time": "13:00", "text": "하원 13시", "early": True}
            out.append({"digest": dg, "contentHash": content_hash(text)})
        return out


def digest(title="숲 체험", event=None, **extra):
    d = {"title": title, "summary": f"{title} 요약", "kinds": ["체험·견학"], "dateConfidence": "exact", "eventDate": event}
    d.update(extra)
    return d


def notice_body(text, received, dg, **extra):
    return {"source": "manual", "receivedOn": received, "contentHash": hashlib.sha256(text.encode()).hexdigest(),
            "digest": dg, "originalText": text, **extra}


class V2Server(unittest.TestCase):
    notice_source = None

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db = Path(self.tmp.name) / "t.sqlite3"
        self.analyzer = FakeAnalyzer()
        self.fetch_calls = []
        self.config = app.Config(db_path=self.db, dist_dir=Path(self.tmp.name) / "dist", notice_source=self.notice_source,
                                 analyzer=self.analyzer, weather_fetcher=self._fetcher_factory)
        with redirect_stdout(io.StringIO()):
            self.server = app.make_server(self.config, "127.0.0.1", 0)
        app.create_user(self.db, "owner", OWNER_PW, "owner")
        app.create_user(self.db, "mom", ADULT_PW, "adult")
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.owner = self.login("owner", OWNER_PW)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.tmp.cleanup()

    def _fetcher_factory(self, key):
        def fetch(op, params):
            self.fetch_calls.append(op)
            if getattr(self, "weather_fail", False):
                raise weather.WeatherError("연결 실패")
            if key == "bad-key":
                raise weather.WeatherError("기상청 서비스 키가 등록되지 않았거나 이 API 활용 신청이 안 되어 있어요.")
            return fake_kma(op, params)
        return fetch

    def login(self, uid, pw):
        j = Jar(self.port)
        st, _, _ = j.request("POST", "/api/login", {"id": uid, "password": pw})
        self.assertEqual(st, 200)
        return j

    def put_doc(self, data):
        st, cur, _ = self.owner.request("GET", "/api/state?meta=1")
        st, _, _ = self.owner.request("PUT", "/api/state", {"baseVersion": cur["version"], "data": data})
        self.assertEqual(st, 200)

    def setting(self, key, value, jar=None):
        jar = jar or self.owner
        _, s, _ = jar.request("GET", "/api/settings")
        return jar.request("PUT", f"/api/settings/{key}", {"value": value, "baseVersion": s["_versions"][key]})


def fake_kma(op, params):
    bd, bt = params["base_date"], params["base_time"]
    if op == "getUltraSrtNcst":
        items = [{"category": "T1H", "obsrValue": "2.5"}, {"category": "PTY", "obsrValue": "0"},
                 {"category": "WSD", "obsrValue": "3.1"}, {"category": "REH", "obsrValue": "40"}]
    else:
        start = datetime.strptime(bd + bt, "%Y%m%d%H%M")
        items = []
        for i in range(1, 40):
            t = start + timedelta(hours=i)
            fd, ft = t.strftime("%Y%m%d"), t.strftime("%H00")
            for cat, val in (("TMP", "3"), ("POP", "20"), ("PTY", "0"), ("SKY", "1"), ("WSD", "2.0"), ("REH", "40")):
                items.append({"fcstDate": fd, "fcstTime": ft, "category": cat, "fcstValue": val})
    return {"response": {"header": {"resultCode": "00", "resultMsg": "OK"}, "body": {"items": {"item": items}}}}


FAMILY_DOC = {
    "v": 1, "families": [{"id": "f1", "name": "몽글", "timezone": "Asia/Seoul", "createdAt": "2026-01-01T00:00:00Z"}],
    "members": [{"familyId": "f1", "userId": "u1", "displayName": "엄마", "role": "owner"}],
    "children": [{"familyId": "f1", "id": "c1", "displayName": "서윤", "avatarKey": "bodeuli", "active": True}],
    "events": [], "tasks": [], "habitTemplates": [], "habitRecords": [],
}


# ───────────────────────── 마이그레이션 ─────────────────────────
class MigrationTests(unittest.TestCase):
    def make_v1(self, path: Path):
        conn = app.connect(path)
        conn.executescript(app.SCHEMA_SQL)
        conn.execute("INSERT INTO schema_meta(key, value) VALUES('schema_version','1')")
        conn.execute("INSERT INTO family_doc(id, version, data, updated_at) VALUES(1, 7, ?, 'x')", (json.dumps(FAMILY_DOC),))
        conn.execute("INSERT INTO users(login_id, role, salt, password_hash, iterations, created_at) VALUES('owner','owner','aa','bb',1,'x')")
        conn.close()

    def test_v1_db_upgrades_with_backup_and_keeps_data(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = Path(tmp) / "family.sqlite3"
            self.make_v1(db)
            backup = app.init_db(db)
            self.assertIsNotNone(backup)
            self.assertTrue(backup.is_file())
            conn = app.connect(db)
            self.assertEqual(migrations.current_version(conn), 2)
            row = conn.execute("SELECT version, data FROM family_doc").fetchone()
            self.assertEqual(row["version"], 7)
            self.assertEqual(json.loads(row["data"]), FAMILY_DOC)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0], 1)
            self.assertIsNotNone(conn.execute("SELECT 1 FROM sqlite_master WHERE name='notices'").fetchone())
            conn.close()
            # 백업 파일은 v1 그대로다
            b = sqlite3.connect(str(backup))
            self.assertEqual(b.execute("SELECT value FROM schema_meta").fetchone()[0], "1")
            b.close()
            # 다시 실행해도 아무 일도 하지 않는다
            self.assertIsNone(app.init_db(db))

    def test_failed_migration_rolls_back(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = Path(tmp) / "family.sqlite3"
            self.make_v1(db)

            def boom(conn):
                conn.execute("CREATE TABLE half_done(x)")
                raise RuntimeError("중간 실패")

            with mock.patch.object(migrations, "MIGRATIONS", [migrations.Migration(2, "x", boom)]):
                with self.assertRaises(migrations.MigrationError) as cm:
                    app.init_db(db)
            self.assertIsNotNone(cm.exception.backup)
            conn = app.connect(db)
            self.assertEqual(migrations.current_version(conn), 1)
            self.assertIsNone(conn.execute("SELECT 1 FROM sqlite_master WHERE name='half_done'").fetchone())
            conn.close()

    def test_dry_run_does_not_touch_db_and_restore_works(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = Path(tmp) / "family.sqlite3"
            self.make_v1(db)
            before = db.read_bytes()
            lines = migrations.dry_run(db, app.connect)
            self.assertIn("v1 → v2", lines[-1])
            self.assertIn("integrity_check=ok", lines[-1])
            conn = app.connect(db)
            self.assertEqual(migrations.current_version(conn), 1)
            conn.close()
            backup = app.init_db(db)
            migrations.restore_backup(backup, db)
            conn = app.connect(db)
            self.assertEqual(migrations.current_version(conn), 1)
            conn.close()
            self.assertTrue(any(p.name.startswith("family.sqlite3.before-restore-") for p in Path(tmp).iterdir()))
            del before


# ───────────────────────── 세션·TV 기기 ─────────────────────────
class SessionAndDeviceTests(V2Server):
    def test_session_slides_while_used(self):
        conn = app.connect(self.db)
        conn.execute("UPDATE sessions SET expires_at = ?", (int(time.time()) + 60,))
        conn.close()
        st, _, hdrs = self.owner.request("GET", "/api/me")
        self.assertEqual(st, 200)
        self.assertIn("mgfb_session=", hdrs.get("Set-Cookie", ""))
        conn = app.connect(self.db)
        exp = conn.execute("SELECT expires_at FROM sessions").fetchone()[0]
        conn.close()
        self.assertGreater(exp, int(time.time()) + app.SESSION_TTL_SECONDS - 60)

    def test_session_not_extended_past_absolute_cap(self):
        conn = app.connect(self.db)
        old = int(time.time()) - app.SESSION_MAX_AGE_SECONDS + 100
        conn.execute("UPDATE sessions SET created_at = ?, expires_at = ?", (old, int(time.time()) + 60))
        conn.close()
        _, _, hdrs = self.owner.request("GET", "/api/me")
        self.assertNotIn("mgfb_session=", hdrs.get("Set-Cookie", ""))

    def pair_tv(self):
        st, code, _ = self.owner.request("POST", "/api/devices/pairing-codes", {})
        self.assertEqual(st, 200)
        tv = Jar(self.port)
        st, dev, _ = tv.request("POST", "/api/devices/pair", {"code": code["code"], "label": "거실 TV"})
        self.assertEqual(st, 200, dev)
        self.assertIn("mgfb_device", tv.cookies)
        return tv, dev, code

    def test_tv_reads_board_but_not_admin_data(self):
        self.put_doc(FAMILY_DOC)
        tv, dev, _ = self.pair_tv()
        st, b, _ = tv.request("GET", "/api/board")
        self.assertEqual(st, 200)
        self.assertEqual(b["viewer"]["kind"], "device")
        self.assertEqual(b["children"][0]["displayName"], "서윤")
        for path in ("/api/state", "/api/notices", "/api/settings", "/api/backup", "/api/devices", "/api/me", "/api/preparations"):
            st, _, _ = tv.request("GET", path)
            self.assertEqual(st, 401, path)
        st, _, _ = tv.request("PUT", "/api/state", {"baseVersion": 1, "data": {}})
        self.assertEqual(st, 401)
        st, me, _ = tv.request("GET", "/api/device/me")
        self.assertEqual((st, me["label"], me["familyName"]), (200, "거실 TV", "몽글"))

    def test_pairing_code_single_use_and_revoke(self):
        tv, dev, code = self.pair_tv()
        other = Jar(self.port)
        st, err, _ = other.request("POST", "/api/devices/pair", {"code": code["code"]})
        self.assertEqual((st, err["error"]["code"]), (400, "PAIRING_INVALID"))
        st, _, _ = self.owner.request("DELETE", f"/api/devices/{dev['id']}")
        self.assertEqual(st, 200)
        st, _, _ = tv.request("GET", "/api/board")
        self.assertEqual(st, 401)
        st, lst, _ = self.owner.request("GET", "/api/devices")
        self.assertIsNotNone(lst["devices"][0]["revokedAt"])

    def test_expired_code_and_bad_code_rate_limit(self):
        conn = app.connect(self.db)
        res = bs.create_pairing_code(conn, "owner", now=int(time.time()) - 3600)
        conn.close()
        tv = Jar(self.port)
        st, err, _ = tv.request("POST", "/api/devices/pair", {"code": res["code"]})
        self.assertEqual(st, 400)
        for _ in range(9):
            tv.request("POST", "/api/devices/pair", {"code": "000000"})
        st, _, _ = tv.request("POST", "/api/devices/pair", {"code": "000001"})
        self.assertEqual(st, 429)

    def test_device_unpair_clears_cookie(self):
        tv, _, _ = self.pair_tv()
        st, _, _ = tv.request("POST", "/api/device/unpair", {})
        self.assertEqual(st, 200)
        self.assertNotIn("mgfb_device", tv.cookies)

    def test_logged_in_adult_with_stale_device_cookie_still_works(self):
        tv, dev, _ = self.pair_tv()
        self.owner.cookies["mgfb_device"] = tv.cookies["mgfb_device"]
        st, b, _ = self.owner.request("GET", "/api/board")
        self.assertEqual((st, b["viewer"]["kind"]), (200, "user"))


# ───────────────────────── 설정 ─────────────────────────
class SettingsTests(V2Server):
    def test_put_get_conflict_and_validation(self):
        st, res, _ = self.setting("screen", {"morningFrom": "05:30", "afternoonFrom": "12:00", "eveningFrom": "18:30"})
        self.assertEqual((st, res["version"]), (200, 1))
        st, err, _ = self.owner.request("PUT", "/api/settings/screen", {"value": {"morningFrom": "05:30", "afternoonFrom": "12:00", "eveningFrom": "18:30"}, "baseVersion": 0})
        self.assertEqual((st, err["error"]["code"]), (409, "VERSION_CONFLICT"))
        st, _, _ = self.setting("screen", {"morningFrom": "12:00", "afternoonFrom": "11:00", "eveningFrom": "18:00"})
        self.assertEqual(st, 400)
        st, _, _ = self.setting("location", {"name": "파리", "lat": 48.8, "lon": 2.3})
        self.assertEqual(st, 400)
        st, _, _ = self.setting("location", {"name": "서울시청", "lat": 37.5665, "lon": 126.978})
        self.assertEqual(st, 200)
        _, s, _ = self.owner.request("GET", "/api/settings")
        self.assertEqual(s["location"]["grid"], [60, 127])
        self.assertFalse(s["weatherKeyConfigured"])

    def test_commute_validation_and_owner_only_settings(self):
        st, _, _ = self.setting("commute", {"children": {"c1": {"leaveHomeAt": "09:00", "arriveBy": "08:30", "pickupAt": "16:00"}}})
        self.assertEqual(st, 400)
        mom = self.login("mom", ADULT_PW)
        st, _, _ = self.setting("kidsnote", {"enabled": True}, jar=mom)
        self.assertEqual(st, 403)
        st, _, _ = self.setting("kidsnote", {"enabled": True, "times": ["01:00"] * 1 + ["02:00", "03:00", "04:00", "05:00", "06:00", "07:00"]})
        self.assertEqual(st, 400)


# ───────────────────────── 공지 ─────────────────────────
class NoticeTests(V2Server):
    def test_general_notice_auto_and_prep_derived(self):
        body = notice_body("내일 숲 체험, 물통", "2026-11-20", digest(event="2026-11-21", supplies=[{"text": "물통", "for": "dropoff"}]))
        st, res, _ = self.owner.request("POST", "/api/notices", body)
        self.assertEqual(st, 201)
        n = res["notice"]
        self.assertEqual(n["status"], "auto")
        self.assertFalse(n["hasOriginal"])  # 원문은 기본으로 저장하지 않는다
        st, prep, _ = self.owner.request("GET", "/api/preparations?from=2026-11-21&to=2026-11-21")
        self.assertEqual([p["text"] for p in prep["items"]], ["물통"])
        self.assertEqual(prep["items"][0]["date"], "2026-11-21")
        # 같은 내용은 다시 저장하지 않는다
        st, res2, _ = self.owner.request("POST", "/api/notices", body)
        self.assertEqual((st, res2["duplicate"], res2["notice"]["id"]), (200, True, n["id"]))

    def test_important_notice_needs_review_until_confirmed(self):
        dg = digest("조기 하원 안내", event="2026-11-21", pickupChange={"date": "2026-11-21", "time": "13:00", "text": "13시 하원", "early": True})
        st, res, _ = self.owner.request("POST", "/api/notices", notice_body("조기 하원", "2026-11-20", dg))
        n = res["notice"]
        self.assertEqual(n["status"], "needs_review")
        self.assertIn("조기 하원", n["reviewReasons"])
        self.setting("commute", {"children": {"c1": {"leaveHomeAt": "08:30", "arriveBy": "09:00", "pickupAt": "16:30"}}})
        self.put_doc(FAMILY_DOC)
        _, cm, _ = self.owner.request("GET", "/api/commute?from=2026-11-21&to=2026-11-21")
        plan = cm["days"][0]["plans"][0]
        self.assertEqual(plan["pickupAt"], "13:00")
        self.assertTrue(plan["needsReview"])
        st, n2, _ = self.owner.request("POST", f"/api/notices/{n['id']}/confirm", {"baseVersion": n["version"]})
        self.assertEqual((st, n2["status"]), (200, "confirmed"))
        _, cm, _ = self.owner.request("GET", "/api/commute?from=2026-11-21&to=2026-11-21")
        self.assertFalse(cm["days"][0]["plans"][0]["needsReview"])
        # 오래된 version 으로 확인하면 충돌
        st, _, _ = self.owner.request("POST", f"/api/notices/{n['id']}/confirm", {"baseVersion": n["version"]})
        self.assertEqual(st, 409)

    def test_ambiguous_date_needs_review(self):
        dg = digest("행사", event="2026-11-23", dateConfidence="inferred")
        _, res, _ = self.owner.request("POST", "/api/notices", notice_body("행사", "2026-11-20", dg))
        self.assertIn("날짜 확인", res["notice"]["reviewReasons"])

    def test_edit_keeps_done_state_and_records_history(self):
        dg = digest(event="2026-11-21", supplies=[{"text": "물통", "for": "dropoff"}, {"text": "모자", "for": "dropoff"}])
        _, res, _ = self.owner.request("POST", "/api/notices", notice_body("숲 물통 모자", "2026-11-20", dg))
        n = res["notice"]
        _, prep, _ = self.owner.request("GET", "/api/preparations?from=2026-11-21&to=2026-11-21")
        bottle = next(p for p in prep["items"] if p["text"] == "물통")
        self.owner.request("PATCH", f"/api/preparations/{bottle['id']}", {"done": True})
        dg2 = digest(event="2026-11-21", supplies=[{"text": "물통", "for": "dropoff"}])
        st, n2, _ = self.owner.request("PUT", f"/api/notices/{n['id']}", {"baseVersion": n["version"], "digest": dg2})
        self.assertEqual((st, n2["status"], n2["editedByUser"]), (200, "confirmed", True))
        _, prep, _ = self.owner.request("GET", "/api/preparations?from=2026-11-21&to=2026-11-21")
        self.assertEqual([(p["text"], bool(p["doneAt"])) for p in prep["items"]], [("물통", True)])
        _, hist, _ = self.owner.request("GET", f"/api/notices/{n['id']}/history")
        self.assertEqual([h["action"] for h in hist["history"]][:2], ["edit", "edit_before"])

    def test_dismiss_and_delete_hide_derived(self):
        dg = digest(event="2026-11-21", supplies=[{"text": "물통", "for": "dropoff"}])
        _, res, _ = self.owner.request("POST", "/api/notices", notice_body("a", "2026-11-20", dg))
        n = res["notice"]
        self.owner.request("POST", f"/api/notices/{n['id']}/confirm", {"baseVersion": n["version"], "dismiss": True})
        _, prep, _ = self.owner.request("GET", "/api/preparations?from=2026-11-21&to=2026-11-21")
        self.assertEqual(prep["items"], [])
        st, _, _ = self.owner.request("DELETE", f"/api/notices/{n['id']}")
        self.assertEqual(st, 200)
        st, _, _ = self.owner.request("GET", f"/api/notices/{n['id']}")
        self.assertEqual(st, 404)

    def test_original_text_only_when_enabled(self):
        self.setting("notices", {"storeOriginal": True})
        _, res, _ = self.owner.request("POST", "/api/notices", notice_body("원문 보관", "2026-11-20", digest()))
        self.assertTrue(res["notice"]["hasOriginal"])
        _, full, _ = self.owner.request("GET", f"/api/notices/{res['notice']['id']}?original=1")
        self.assertEqual(full["originalText"], "원문 보관")
        mom = self.login("mom", ADULT_PW)
        st, _, _ = self.setting("notices", {"storeOriginal": False}, jar=mom)
        self.assertEqual(st, 403)

    def test_import_preview_then_commit(self):
        items = [notice_body("가", "2026-11-01", digest("가")), notice_body("나", "2026-11-02", digest("나")),
                 {"receivedOn": "nope", "digest": {"title": "x"}}]
        for it in items[:2]:
            it["source"] = "gongjitalk"
        self.owner.request("POST", "/api/notices", notice_body("가", "2026-11-01", digest("가")))
        st, prev, _ = self.owner.request("POST", "/api/notices/import", {"items": items, "preview": True})
        self.assertEqual([r["status"] for r in prev["results"]], ["duplicate", "new", "invalid"])
        _, lst, _ = self.owner.request("GET", "/api/notices")
        self.assertEqual(len(lst["notices"]), 1)  # 미리보기는 저장하지 않는다
        st, res, _ = self.owner.request("POST", "/api/notices/import", {"items": items, "preview": False})
        self.assertEqual(res["summary"], {"new": 0, "created": 1, "duplicate": 1, "invalid": 1})

    def test_validation(self):
        st, _, _ = self.owner.request("POST", "/api/notices", {"receivedOn": "2026-11-20", "contentHash": "x", "digest": digest()})
        self.assertEqual(st, 400)
        st, _, _ = self.owner.request("POST", "/api/notices", notice_body("a", "2026-11-20", {"title": ""}))
        self.assertEqual(st, 400)
        st, _, _ = self.owner.request("POST", "/api/notices", {**notice_body("a", "2026-11-20", digest()), "source": "kidsnote"})
        self.assertEqual(st, 400)


class BackupV2Tests(V2Server):
    def test_backup_includes_v2_tables_and_restore_rolls_them_back(self):
        self.put_doc(FAMILY_DOC)
        self.setting("notices", {"storeOriginal": True})
        _, res, _ = self.owner.request("POST", "/api/notices", notice_body("백업 전 공지", "2026-11-20", digest("백업 전")))
        st, bk, _ = self.owner.request("GET", "/api/backup")
        self.assertEqual(st, 200)
        self.assertEqual(len(bk["v2"]["notices"]), 1)
        self.assertIsNone(bk["v2"]["notices"][0]["original_text"])  # 원문은 백업 파일에 넣지 않는다
        self.owner.request("POST", "/api/notices", notice_body("백업 후 공지", "2026-11-20", digest("백업 후")))
        st, r, _ = self.owner.request("POST", "/api/restore", bk)
        self.assertEqual(st, 200, r)
        self.assertTrue(r["v2Restored"])
        _, lst, _ = self.owner.request("GET", "/api/notices")
        self.assertEqual([n["title"] for n in lst["notices"]], ["백업 전"])
        bad = {**bk, "v2": {"notices": "x"}}
        st, _, _ = self.owner.request("POST", "/api/restore", bad)
        self.assertEqual(st, 400)
        broken = json.loads(json.dumps(bk))
        broken["v2"]["notices"][0]["digest"] = "{not json"
        st, _, _ = self.owner.request("POST", "/api/restore", broken)
        self.assertEqual(st, 400)
        _, lst, _ = self.owner.request("GET", "/api/notices")
        self.assertEqual([n["title"] for n in lst["notices"]], ["백업 전"])  # 실패한 복원은 아무것도 바꾸지 않는다


class AtomicImportAndPrivacyTests(V2Server):
    def test_import_commit_is_all_or_nothing(self):
        items = [notice_body(f"공지 {i}", "2026-11-0" + str(i + 1), digest(f"공지 {i}")) for i in range(3)]
        real = bs.create_notice
        calls = {"n": 0}

        def flaky(conn, body, actor, **kw):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("디스크 오류 흉내")
            return real(conn, body, actor, **kw)

        with mock.patch.object(bs, "create_notice", flaky), redirect_stderr(io.StringIO()):
            st, _, _ = self.owner.request("POST", "/api/notices/import", {"items": items, "preview": False})
        self.assertEqual(st, 500)
        _, lst, _ = self.owner.request("GET", "/api/notices")
        self.assertEqual(lst["notices"], [])  # 첫 번째 것도 남지 않는다
        st, res, _ = self.owner.request("POST", "/api/notices/import", {"items": items, "preview": False})
        self.assertEqual(res["summary"]["created"], 3)

    def test_tv_privacy_masks_only_on_tv(self):
        self.put_doc(FAMILY_DOC)
        self.setting("commute", {"children": {"c1": {"leaveHomeAt": "08:30", "arriveBy": "09:00", "pickupAt": "16:30", "pickupAssignee": "엄마"}}})
        today = bs.today_kst()
        self.owner.request("POST", "/api/notices", notice_body("x", today, digest("비밀 공지 제목", event=bs.add_days(today, 1))))
        st, _, _ = self.setting("tvPrivacy", {"hideChildNames": True, "hideNoticeTitles": True, "hidePickup": True})
        self.assertEqual(st, 200)
        st, code, _ = self.owner.request("POST", "/api/devices/pairing-codes", {})
        tv = Jar(self.port)
        tv.request("POST", "/api/devices/pair", {"code": code["code"]})
        _, b, _ = tv.request("GET", "/api/board")
        self.assertEqual(b["children"][0]["displayName"], "우리 아이")
        self.assertEqual(b["notices"]["top"][0]["title"], "새 공지")
        self.assertTrue(all(p["assignee"] is None for p in b["pickups"]))
        self.assertNotIn("서윤", json.dumps(b, ensure_ascii=False))
        self.assertNotIn("비밀 공지 제목", json.dumps(b, ensure_ascii=False))
        _, ob, _ = self.owner.request("GET", "/api/board")  # 보호자 화면은 그대로
        self.assertEqual(ob["children"][0]["displayName"], "서윤")
        self.assertEqual(ob["notices"]["top"][0]["title"], "비밀 공지 제목")

    def test_device_token_extends_while_used(self):
        st, code, _ = self.owner.request("POST", "/api/devices/pairing-codes", {})
        tv = Jar(self.port)
        _, dev, _ = tv.request("POST", "/api/devices/pair", {"code": code["code"]})
        conn = app.connect(self.db)
        old = int(time.time()) - 2 * 3600
        conn.execute("UPDATE devices SET last_seen_at = ?, expires_at = ? WHERE id = ?", (old, old + 7200 + 600, dev["id"]))
        conn.close()
        st, _, _ = tv.request("GET", "/api/board")
        self.assertEqual(st, 200)
        conn = app.connect(self.db)
        exp = conn.execute("SELECT expires_at FROM devices WHERE id = ?", (dev["id"],)).fetchone()[0]
        conn.close()
        self.assertGreater(exp, int(time.time()) + bs.DEVICE_IDLE_TTL - 60)


class ReviewFixTests(V2Server):
    """2026-11-20 Codex·Claude 리뷰 지적 회귀 테스트"""

    def test_unresolved_time_needs_review(self):
        dg = digest("하원 시간 변경", needsConfirmation=["날짜·시각을 확인해 주세요: 하원 시간이 오후 3시로 바뀝니다."])
        _, res, _ = self.owner.request("POST", "/api/notices", notice_body("하원 3시", "2026-11-20", dg))
        self.assertEqual(res["notice"]["status"], "needs_review")
        self.assertIn("날짜·시각 확인", res["notice"]["reviewReasons"])

    def test_event_date_edit_keeps_same_event_row_and_link(self):
        _, res, _ = self.owner.request("POST", "/api/notices", notice_body("행사", "2026-11-20", digest("발표회", event="2026-11-25")))
        n = res["notice"]
        _, evs, _ = self.owner.request("GET", f"/api/notice-events?noticeId={n['id']}")
        ev = evs["events"][0]
        self.owner.request("PUT", f"/api/notice-events/{ev['id']}/link", {"calendarEventId": "cal_1", "snapshot": {"title": "발표회"}})
        self.owner.request("PUT", f"/api/notices/{n['id']}", {"baseVersion": n["version"], "digest": digest("발표회", event="2026-11-26")})
        _, evs, _ = self.owner.request("GET", f"/api/notice-events?noticeId={n['id']}")
        live = [e for e in evs["events"] if not e["deleted"]]
        self.assertEqual(len(live), 1)
        self.assertEqual((live[0]["id"], live[0]["date"], live[0]["calendarEventId"]), (ev["id"], "2026-11-26", "cal_1"))

    def test_legacy_date_keyed_event_row_keeps_calendar_link(self):
        _, res, _ = self.owner.request("POST", "/api/notices", notice_body("행사", "2026-11-20", digest("발표회", event="2026-11-25")))
        n = res["notice"]
        conn = app.connect(self.db)  # 예전 형식(날짜 기반) 키로 되돌려 둔다
        legacy = bs._key(n["id"], "ev", "2026-11-25")
        conn.execute("UPDATE notice_events SET item_key = ?, calendar_event_id = 'cal_old', calendar_snapshot = ? WHERE notice_id = ?",
                     (legacy, json.dumps({"title": "발표회", "date": "2026-11-25", "endDate": None, "time": None}), n["id"]))
        row_id = conn.execute("SELECT id FROM notice_events WHERE notice_id = ?", (n["id"],)).fetchone()[0]
        conn.close()
        self.owner.request("PUT", f"/api/notices/{n['id']}", {"baseVersion": n["version"], "digest": digest("발표회", event="2026-11-27")})
        _, evs, _ = self.owner.request("GET", f"/api/notice-events?noticeId={n['id']}")
        self.assertEqual([(e["id"], e["date"], e["calendarEventId"], e["deleted"]) for e in evs["events"]], [(row_id, "2026-11-27", "cal_old", False)])

    def test_weather_key_entry_owner_only_tested_and_never_echoed(self):
        mom = self.login("mom", ADULT_PW)
        st, _, _ = mom.request("PUT", "/api/weather-key", {"key": "good-key"})
        self.assertEqual(st, 403)
        st, err, _ = self.owner.request("PUT", "/api/weather-key", {"key": "bad-key"})
        self.assertEqual((st, err["error"]["code"]), (400, "WEATHER_KEY_INVALID"))
        self.assertFalse((self.db.parent / "kma_key.txt").exists())  # 틀린 키는 저장하지 않는다
        with mock.patch.dict("os.environ", {"MGFB_KMA_KEY": ""}):
            st, res, _ = self.owner.request("PUT", "/api/weather-key", {"key": "good-key-123"})
            self.assertEqual((st, res["check"]), (200, "ok"))
            self.assertNotIn("good-key-123", json.dumps(res))
            _, s, _ = self.owner.request("GET", "/api/settings")
            self.assertEqual((s["weatherKeyConfigured"], s["weatherKeySource"]), (True, "file"))
            self.assertNotIn("good-key-123", json.dumps(s))
            st, _, _ = self.owner.request("DELETE", "/api/weather-key")
            _, s, _ = self.owner.request("GET", "/api/settings")
            self.assertFalse(s["weatherKeyConfigured"])
        st, _, _ = self.owner.request("PUT", "/api/weather-key", {"key": "has space"})
        self.assertEqual(st, 400)

    def test_non_owner_cannot_force_store_original(self):
        mom = self.login("mom", ADULT_PW)
        _, res, _ = mom.request("POST", "/api/notices", {**notice_body("원문", "2026-11-20", digest()), "storeOriginal": True})
        self.assertFalse(res["notice"]["hasOriginal"])
        _, res, _ = self.owner.request("POST", "/api/notices", {**notice_body("원문2", "2026-11-20", digest("b")), "storeOriginal": True})
        self.assertTrue(res["notice"]["hasOriginal"])

    def test_confirm_after_dismiss_restores_derived(self):
        dg = digest(event="2026-11-21", supplies=[{"text": "물통", "for": "dropoff"}])
        _, res, _ = self.owner.request("POST", "/api/notices", notice_body("숨김", "2026-11-20", dg))
        n = res["notice"]
        _, n2, _ = self.owner.request("POST", f"/api/notices/{n['id']}/confirm", {"baseVersion": n["version"], "dismiss": True})
        self.owner.request("POST", f"/api/notices/{n['id']}/confirm", {"baseVersion": n2["version"]})
        _, prep, _ = self.owner.request("GET", "/api/preparations?from=2026-11-21&to=2026-11-21")
        self.assertEqual([p["text"] for p in prep["items"]], ["물통"])

    def test_restore_backs_up_db_and_keeps_tables_missing_from_file(self):
        self.put_doc(FAMILY_DOC)
        self.owner.request("POST", "/api/notices", notice_body("남아야 할 공지", "2026-11-20", digest("남는 공지")))
        _, bk, _ = self.owner.request("GET", "/api/backup")
        partial = {**bk, "v2": {"pickups": []}}  # notices 표가 없는 백업
        st, _, _ = self.owner.request("POST", "/api/restore", partial)
        self.assertEqual(st, 200)
        _, lst, _ = self.owner.request("GET", "/api/notices")
        self.assertEqual([n["title"] for n in lst["notices"]], ["남는 공지"])
        backups = list((self.db.parent / "backups").glob("pre-restore-*.sqlite3"))
        self.assertEqual(len(backups), 1)

    def test_tv_privacy_scrubs_names_and_prep_notice_titles(self):
        self.put_doc(FAMILY_DOC)
        today = bs.today_kst()
        dg = digest("서윤 투약 안내", event=today, supplies=[{"text": "서윤 여벌옷", "for": "dropoff"}])
        self.owner.request("POST", "/api/notices", notice_body("투약", today, dg))
        self.setting("tvPrivacy", {"hideChildNames": True})
        st, code, _ = self.owner.request("POST", "/api/devices/pairing-codes", {})
        tv = Jar(self.port)
        tv.request("POST", "/api/devices/pair", {"code": code["code"]})
        _, b, hdrs = tv.request("GET", "/api/board")
        self.assertNotIn("서윤", json.dumps(b, ensure_ascii=False))
        self.assertTrue(all(p["noticeTitle"] is None for p in b["prep"]["today"]))
        self.assertIn("mgfb_device=", hdrs.get("Set-Cookie", ""))  # 쓰는 동안 쿠키도 연장

    def test_nan_confidence_is_rejected_cleanly(self):
        raw = json.dumps(notice_body("nan", "2026-11-20", digest())).replace('"digest": {', '"digest": {"confidence": NaN, ', 1).encode()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        conn.request("POST", "/api/notices", body=raw, headers={"Content-Type": "application/json", "Cookie": "; ".join(f"{k}={v}" for k, v in self.owner.cookies.items())})
        res = conn.getresponse()
        res.read()
        conn.close()
        self.assertIn(res.status, (200, 201))


# ───────────────────────── 등하원·픽업·보드 ─────────────────────────
class CommuteBoardTests(V2Server):
    def setUp(self):
        super().setUp()
        self.put_doc(FAMILY_DOC)
        self.setting("commute", {"children": {"c1": {
            "weekdays": [1, 2, 3, 4, 5], "leaveHomeAt": "08:30", "arriveBy": "09:00", "pickupAt": "16:30",
            "pickupAtByWeekday": {"5": "15:30"}, "pickupAssignee": "엄마", "pickupAssigneeByWeekday": {"3": "할머니"}}}})

    def test_commute_rules(self):
        _, cm, _ = self.owner.request("GET", "/api/commute?from=2026-11-18&to=2026-11-22")
        by = {d["date"]: d["plans"][0] for d in cm["days"]}
        self.assertEqual(by["2026-11-18"]["pickupAssignee"], "할머니")  # 수요일
        self.assertEqual(by["2026-11-20"]["pickupAt"], "15:30")  # 금요일
        self.assertFalse(by["2026-11-22"]["attends"])  # 일요일
        st, _, _ = self.owner.request("POST", "/api/commute/exceptions", {"kind": "dropoff_time", "date": "2026-11-19", "time": "09:30"})
        self.assertEqual(st, 201)
        st, _, _ = self.owner.request("POST", "/api/commute/exceptions", {"kind": "closed", "date": "2026-11-20", "note": "개원기념일"})
        _, cm, _ = self.owner.request("GET", "/api/commute?from=2026-11-19&to=2026-11-20")
        by = {d["date"]: d["plans"][0] for d in cm["days"]}
        self.assertEqual((by["2026-11-19"]["leaveHomeAt"], by["2026-11-19"]["arriveBy"]), ("09:00", "09:30"))
        self.assertEqual((by["2026-11-20"]["attends"], by["2026-11-20"]["closedNote"]), (False, "개원기념일"))

    def test_pickups_default_manual_done(self):
        _, p, _ = self.owner.request("GET", "/api/pickups?from=2026-11-18&to=2026-11-18")
        self.assertEqual((p["pickups"][0]["assignee"], p["pickups"][0]["assigneeSource"]), ("할머니", "default"))
        self.assertEqual(p["adults"], ["엄마"])
        self.owner.request("PUT", "/api/pickups", {"date": "2026-11-18", "childId": "c1", "assignee": "아빠"})
        self.owner.request("PUT", "/api/pickups", {"date": "2026-11-18", "childId": "c1", "done": True})
        _, p, _ = self.owner.request("GET", "/api/pickups?from=2026-11-18&to=2026-11-18")
        self.assertEqual((p["pickups"][0]["assignee"], p["pickups"][0]["assigneeSource"], p["pickups"][0]["doneBy"]), ("아빠", "manual", "owner"))

    def test_board_hides_private_events_and_ranks_review_first(self):
        today = bs.today_kst()
        doc = json.loads(json.dumps(FAMILY_DOC))
        doc["events"] = [
            {"id": "e1", "familyId": "f1", "title": "가족 외식", "allDay": True, "startDate": today, "endDate": today, "startsAt": None, "endsAt": None, "visibility": "family"},
            {"id": "e2", "familyId": "f1", "title": "비밀 선물", "allDay": True, "startDate": today, "endDate": today, "startsAt": None, "endsAt": None, "visibility": "private"},
        ]
        self.put_doc(doc)
        self.owner.request("POST", "/api/notices", notice_body("일반", today, digest("일반 공지", event=bs.add_days(today, 3))))
        self.owner.request("POST", "/api/notices", notice_body("중요", today, digest("휴원 안내", closure={"date": bs.add_days(today, 5), "text": "휴원"})))
        _, b, _ = self.owner.request("GET", "/api/board")
        self.assertEqual([e["title"] for e in b["events"]["today"]], ["가족 외식"])
        self.assertEqual(b["notices"]["needsReview"], 1)
        self.assertEqual([n["title"] for n in b["notices"]["top"]], ["휴원 안내", "일반 공지"])
        self.assertEqual(b["weather"], {"configured": False, "reason": "location"})
        self.assertIn(b["screen"]["mode"], ("morning", "afternoon", "evening"))
        self.assertTrue(b["commute"]["configured"])

    def test_notice_event_link(self):
        today = bs.today_kst()
        _, res, _ = self.owner.request("POST", "/api/notices", notice_body("x", today, digest("발표회", event=bs.add_days(today, 1))))
        _, evs, _ = self.owner.request("GET", f"/api/notice-events?from={today}&to={bs.add_days(today, 3)}")
        ev = evs["events"][0]
        st, _, _ = self.owner.request("PUT", f"/api/notice-events/{ev['id']}/link", {"calendarEventId": "cal_1", "snapshot": {"title": "발표회"}})
        self.assertEqual(st, 200)
        _, evs, _ = self.owner.request("GET", f"/api/notice-events?from={today}&to={bs.add_days(today, 3)}")
        self.assertEqual(evs["events"][0]["calendarEventId"], "cal_1")


# ───────────────────────── 날씨 ─────────────────────────
class WeatherUnitTests(unittest.TestCase):
    def test_grid_and_bases(self):
        self.assertEqual(weather.latlon_to_grid(37.5665, 126.978), (60, 127))
        self.assertEqual(weather.latlon_to_grid(35.1796, 129.0756), (98, 76))
        t = datetime(2026, 11, 20, 8, 5, tzinfo=KST)
        self.assertEqual(weather.fcst_base(t), ("20261120", "0500"))
        self.assertEqual(weather.ncst_base(t), ("20261120", "0700"))
        self.assertEqual(weather.fcst_base(datetime(2026, 11, 20, 2, 5, tzinfo=KST)), ("20261119", "2300"))

    def test_advice_rules(self):
        cold = {"tmp": 1, "wsd": 2, "pop": 10, "pty": "none"}
        self.assertEqual([a["text"] for a in weather.advice(cold, cold)], ["두꺼운 옷 필요", "우산 필요 없음"])
        rain_pick = {"tmp": 14, "wsd": 10, "pop": 80, "pty": "rain"}
        mild = {"tmp": 14, "wsd": 1, "pop": 10, "pty": "none"}
        self.assertEqual([a["text"] for a in weather.advice(mild, rain_pick)], ["얇은 겉옷", "하원 때 우산", "바람이 강해요"])
        self.assertEqual(weather.advice(None, None), [])  # 예보가 없으면 추천하지 않는다
        freeze = {"tmp": -8, "wsd": 3, "pop": 0, "pty": "none"}
        self.assertIn("추위 조심", [a["text"] for a in weather.advice(freeze, None)])
        snow = {"tmp": -1, "wsd": 1, "pop": 70, "pty": "snow"}
        self.assertIn("눈 와요, 우산·장화", [a["text"] for a in weather.advice(snow, None)])

    def test_error_responses(self):
        with self.assertRaises(weather.WeatherError):
            weather._items({"response": {"header": {"resultCode": "03", "resultMsg": "NO_DATA"}}})


class WeatherServiceTests(V2Server):
    def setUp(self):
        super().setUp()
        self.setting("location", {"name": "우리 동네", "lat": 37.5665, "lon": 126.978})

    def test_not_configured_without_key(self):
        with mock.patch.dict("os.environ", {"MGFB_KMA_KEY": ""}):
            _, w, _ = self.owner.request("GET", "/api/weather")
        self.assertEqual(w, {"configured": False, "reason": "key", "location": "우리 동네"})

    def test_snapshot_cache_and_stale_fallback(self):
        with mock.patch.dict("os.environ", {"MGFB_KMA_KEY": "test-key"}):
            _, w, _ = self.owner.request("GET", "/api/weather")
            self.assertTrue(w["available"])
            self.assertEqual(w["current"]["temp"], 2.5)
            self.assertFalse(w["stale"])
            calls = len(self.fetch_calls)
            self.owner.request("GET", "/api/weather")
            self.assertEqual(len(self.fetch_calls), calls)  # 같은 발표 시각이면 다시 부르지 않는다
            # 캐시를 오래된 것으로 만들고 기상청 장애를 흉내 낸다
            conn = app.connect(self.db)
            conn.execute("UPDATE weather_cache SET base = 'old', fetched_at = fetched_at - 86400")
            conn.close()
            self.weather_fail = True
            _, w2, _ = self.owner.request("GET", "/api/weather")
            self.assertTrue(w2["available"])
            self.assertTrue(w2["stale"])
            self.assertEqual(w2["error"], "연결 실패")
            calls = len(self.fetch_calls)
            self.owner.request("GET", "/api/weather")
            self.assertEqual(len(self.fetch_calls), calls)  # 실패 뒤 5분은 다시 부르지 않는다


class WeatherReviewTests(unittest.TestCase):
    def test_tomorrow_pickup_and_forecast_based_timestamp(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = Path(tmp) / "w.sqlite3"
            app.init_db(db)
            clock = {"now": datetime(2026, 11, 20, 20, 30, tzinfo=KST)}
            svc = weather.WeatherService(Path(tmp), lambda key: fake_kma, clock=lambda: clock["now"])
            with mock.patch.dict("os.environ", {"MGFB_KMA_KEY": "k"}):
                conn = app.connect(db)
                snap = svc.snapshot(conn, {"name": "x", "lat": 37.5665, "lon": 126.978}, "2026-11-20", None, None, "08:30", "15:00")
                conn.execute("UPDATE weather_cache SET fetched_at = fetched_at - 8 * 3600 WHERE kind = 'fcst'")
                snap2 = svc.snapshot(conn, {"name": "x", "lat": 37.5665, "lon": 126.978}, "2026-11-20", None, None, "08:30", "15:00")
                conn.close()
            self.assertEqual(len(snap["tomorrowAdvice"]), 2)  # 오늘은 휴원(시각 없음)이어도 내일 하원 예보를 쓴다
            with mock.patch.dict("os.environ", {"MGFB_KMA_KEY": "k"}):
                conn = app.connect(db)
                only_drop = svc.snapshot(conn, {"name": "x", "lat": 37.5665, "lon": 126.978}, "2026-11-20", "08:30", "16:30", "08:30", None)
                conn.close()
            # 내일 하원 시각이 없으면 오늘 하원 시각(16:30)으로 대신하지 않고 내일 등원 예보만 쓴다
            self.assertEqual(only_drop["tomorrowAdvice"], weather.advice(only_drop["tomorrow"]["dropoff"], None))
            self.assertTrue(snap2["stale"])
            self.assertGreaterEqual(snap2["ageMinutes"], 8 * 60)  # 오래된 단기예보 기준


class WeatherMergeTests(unittest.TestCase):
    def test_new_forecast_keeps_earlier_hours_of_today(self):
        """08:10 발표(다음 시각부터)로 바뀌어도 08시 등원 예보는 이전 발표 값으로 남는다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = Path(tmp) / "w.sqlite3"
            app.init_db(db)
            clock = {"now": datetime(2026, 11, 20, 7, 30, tzinfo=KST)}
            svc = weather.WeatherService(Path(tmp), lambda key: fake_kma, clock=lambda: clock["now"])
            with mock.patch.dict("os.environ", {"MGFB_KMA_KEY": "k"}):
                conn = app.connect(db)
                svc.refresh(conn, 60, 127)  # 05시 발표: 06시부터
                clock["now"] = datetime(2026, 11, 20, 8, 20, tzinfo=KST)
                svc.refresh(conn, 60, 127)  # 08시 발표: 09시부터
                snap = svc.snapshot(conn, {"name": "x", "lat": 37.5665, "lon": 126.978}, "2026-11-20", "08:30", "16:30", "08:30")
                conn.close()
            self.assertIsNotNone(snap["dropoff"])
            self.assertEqual(snap["dropoff"]["time"], "08:30")
            self.assertIsNotNone(snap["pickup"])


# ───────────────────────── 공지 자동 수집 ─────────────────────────
MOCK_ITEMS = [
    {"id": "k1", "postedAt": "2026-11-20T00:10:00Z", "title": "숲 체험", "text": "내일 숲 체험이 있어요. 물통을 보내주세요.", "authorType": "teacher"},
    {"id": "k2", "postedAt": "2026-11-20T01:00:00Z", "title": "조기 하원", "text": "내일은 13시 하원입니다.", "authorType": "admin"},
    {"id": "k3", "postedAt": "2026-11-20T02:00:00Z", "title": "학부모 댓글", "text": "감사합니다", "authorType": "parent"},
]


class OfficialAdapterTests(V2Server):
    def test_official_adapter_is_disabled(self):
        st, s, _ = self.owner.request("GET", "/api/kidsnote/status")
        self.assertEqual(s["adapter"]["mode"], "official")
        self.assertFalse(s["adapter"]["available"])
        self.assertIn("공식 연동 수단", s["adapter"]["reason"])
        st, err, _ = self.owner.request("POST", "/api/kidsnote/sync", {})
        self.assertEqual((st, err["error"]["code"]), (409, "SOURCE_NOT_AVAILABLE"))


class MockSyncTests(V2Server):
    def setUp(self):
        self.mock_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.mock_file = Path(self.mock_dir.name) / "kidsnote.json"
        self.mock_file.write_text(json.dumps(MOCK_ITEMS, ensure_ascii=False), encoding="utf-8")
        self.notice_source = f"mock:{self.mock_file}"
        super().setUp()

    def tearDown(self):
        super().tearDown()
        self.mock_dir.cleanup()

    def sync(self):
        conn = app.connect(self.db)
        conn.execute("UPDATE sync_state SET state = json_set(state, '$.lastRunAt', NULL)")
        conn.close()
        return self.owner.request("POST", "/api/kidsnote/sync", {})

    def test_sync_creates_dedupes_and_updates(self):
        st, r, _ = self.sync()
        self.assertEqual((st, r["fetched"], r["created"]), (200, 2, 2))  # 학부모 글은 제외
        _, lst, _ = self.owner.request("GET", "/api/notices")
        by = {n["sourceId"]: n for n in lst["notices"]}
        self.assertEqual(by["k1"]["status"], "auto")
        self.assertEqual(by["k2"]["status"], "needs_review")
        self.assertFalse(by["k1"]["hasOriginal"])
        _, r2, _ = self.sync()
        self.assertEqual((r2["created"], r2["updated"], r2["skipped"]), (0, 0, 2))
        _, prep, _ = self.owner.request("GET", "/api/preparations?from=2026-11-21&to=2026-11-21")
        self.assertEqual([p["text"] for p in prep["items"]], ["물통"])  # 두 번 수집해도 하나
        items = json.loads(json.dumps(MOCK_ITEMS))
        items[0]["text"] = "내일 숲 체험이 있어요. 물통과 모자를 보내주세요."
        items[0]["updatedAt"] = "2026-11-20T03:00:00Z"
        self.mock_file.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
        _, r3, _ = self.sync()
        self.assertEqual(r3["updated"], 1)

    def test_user_edit_not_overwritten_by_source_change(self):
        self.sync()
        _, lst, _ = self.owner.request("GET", "/api/notices")
        n = next(x for x in lst["notices"] if x["sourceId"] == "k1")
        dg = {**n["digest"], "title": "보호자가 고친 제목"}
        self.owner.request("PUT", f"/api/notices/{n['id']}", {"baseVersion": n["version"], "digest": dg})
        items = json.loads(json.dumps(MOCK_ITEMS))
        items[0]["text"] = "바뀐 원문"
        self.mock_file.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
        self.sync()
        _, n2, _ = self.owner.request("GET", f"/api/notices/{n['id']}")
        self.assertEqual((n2["title"], n2["status"]), ("보호자가 고친 제목", "needs_review"))

    def test_failure_backoff_pause_and_resume(self):
        self.mock_file.write_text(json.dumps({"fail": "서버 점검"}), encoding="utf-8")
        _, r, _ = self.sync()
        self.assertFalse(r["ok"])
        _, s, _ = self.owner.request("GET", "/api/kidsnote/status")
        self.assertEqual(s["state"]["failures"], 1)
        self.assertIsNotNone(s["state"]["nextAllowedAt"])
        for _ in range(4):
            self.sync()
        _, s, _ = self.owner.request("GET", "/api/kidsnote/status")
        self.assertTrue(s["state"]["paused"])
        # 일시정지 상태에서는 예약 실행이 돌지 않는다
        conn = app.connect(self.db)
        self.assertEqual(kidsnote.run_sync(conn, self.server.adapter, self.analyzer, "schedule"), {"skipped": "paused"})
        conn.close()
        _, s, _ = self.owner.request("POST", "/api/kidsnote/resume", {})
        self.assertFalse(s["state"]["paused"])

    def test_manual_sync_rate_limit(self):
        self.sync()
        st, _, _ = self.owner.request("POST", "/api/kidsnote/sync", {})
        self.assertEqual(st, 429)

    def test_pending_analysis_when_analyzer_missing(self):
        self.analyzer.ok = False
        self.sync()
        _, lst, _ = self.owner.request("GET", "/api/notices?status=pending_analysis")
        self.assertEqual(len(lst["notices"]), 2)
        _, pend, _ = self.owner.request("GET", "/api/notices/pending-analysis")
        self.assertTrue(all(p["text"] for p in pend["items"]))
        nid = pend["items"][0]["id"]
        st, n, _ = self.owner.request("POST", f"/api/notices/{nid}/analysis", {"digest": digest("분석 완료")})
        self.assertEqual((st, n["status"], n["hasOriginal"]), (200, "auto", False))

    def test_scheduler_slots(self):
        now = datetime(2026, 11, 20, 7, 30, tzinfo=KST)
        self.assertEqual(kidsnote.due_slot(["07:00", "11:00"], now, None), "2026-11-20T07:00")
        self.assertIsNone(kidsnote.due_slot(["07:00", "11:00"], now, "2026-11-20T07:00"))
        self.assertIsNone(kidsnote.due_slot(["07:00"], datetime(2026, 11, 20, 10, 0, tzinfo=KST), None))  # 2시간 넘게 지남
        self.assertIsNone(kidsnote.due_slot(["07:00"], datetime(2026, 11, 20, 6, 0, tzinfo=KST), None))
        self.setting("kidsnote", {"enabled": True, "times": ["07:00"]})
        sched = kidsnote.SyncScheduler(self.db, app.connect, self.server.adapter, self.analyzer)
        r = sched.tick(datetime(2026, 11, 20, 7, 5, tzinfo=KST))
        self.assertEqual(r["created"], 2)
        self.assertIsNone(sched.tick(datetime(2026, 11, 20, 7, 6, tzinfo=KST)))


if __name__ == "__main__":
    unittest.main()
