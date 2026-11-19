"""태블릿 서버 단위테스트 (표준 라이브러리 unittest만 사용).

실행: python -m unittest discover -s tablet_server/tests -v
"""
from __future__ import annotations

import http.client
import io
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402

OWNER_PW = "owner-password-1"
ADULT_PW = "adult-password-1"


class Client:
    """쿠키를 보관하는 최소 HTTP 클라이언트 (브라우저 한 대에 해당)."""

    def __init__(self, port: int):
        self.port = port
        self.cookie = None

    def request(self, method, path, body=None, headers=None, raw=None):
        h = dict(headers or {})
        data = raw
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            h.setdefault("Content-Type", "application/json")
        if self.cookie:
            h["Cookie"] = self.cookie
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            conn.request(method, path, body=data, headers=h)
            res = conn.getresponse()
            payload = res.read()
            set_cookie = res.getheader("Set-Cookie")
            if set_cookie:
                pair = set_cookie.split(";", 1)[0]
                self.cookie = pair if not pair.endswith("=") else None
            return res.status, dict(res.getheaders()), payload, set_cookie
        finally:
            conn.close()

    def json(self, method, path, body=None, headers=None):
        status, hdrs, payload, _ = self.request(method, path, body, headers)
        return status, (json.loads(payload) if payload and hdrs.get("Content-Type", "").startswith("application/json") else None)

    def login(self, login_id, password):
        return self.json("POST", "/api/login", {"id": login_id, "password": password})


class ServerTestCase(unittest.TestCase):
    max_failures = 5

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        root = Path(cls.tmp.name)
        cls.dist = root / "dist"
        (cls.dist / "assets").mkdir(parents=True)
        (cls.dist / "index.html").write_text("<!doctype html><title>t</title><div id=root></div>", encoding="utf-8")
        (cls.dist / "assets" / "index-abc.js").write_text("console.log(1)", encoding="utf-8")
        (cls.dist / "assets" / "index-abc.css").write_text("body{}", encoding="utf-8")
        (cls.dist / "icon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>", encoding="utf-8")
        (cls.dist / "manifest.webmanifest").write_text("{}", encoding="utf-8")
        (root / "secret.txt").write_text("TOP-SECRET", encoding="utf-8")
        cls.db = root / "data" / "family.sqlite3"
        cls.config = app.Config(db_path=cls.db, dist_dir=cls.dist, login_max_failures=cls.max_failures)
        cls.server = app.make_server(cls.config, "127.0.0.1", 0)
        cls.port = cls.server.server_address[1]
        app.create_user(cls.db, "owner", OWNER_PW, "owner")
        app.create_user(cls.db, "mom", ADULT_PW, "adult")
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls._stderr = redirect_stderr(io.StringIO())  # 접근 로그 억제
        cls._stderr.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls._stderr.__exit__(None, None, None)
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def client(self):
        return Client(self.port)

    def owner(self):
        c = self.client()
        self.assertEqual(c.login("owner", OWNER_PW)[0], 200)
        return c

    def adult(self):
        c = self.client()
        self.assertEqual(c.login("mom", ADULT_PW)[0], 200)
        return c

    def sql(self, query, args=()):
        conn = app.connect(self.db)
        try:
            return conn.execute(query, args).fetchall()
        finally:
            conn.close()


class AuthTests(ServerTestCase):
    max_failures = 1000  # 이 클래스는 속도 제한에 걸리지 않게 한다

    def test_health_is_public_and_minimal(self):
        status, body = self.client().json("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["schemaVersion"], app.SCHEMA_VERSION)
        self.assertEqual(set(body), {"status", "schemaVersion", "serverTime"})

    def test_lan_address_classification_rejects_public_sources(self):
        self.assertTrue(app._is_lan_host("127.0.0.1"))
        self.assertTrue(app._is_lan_host("192.168.0.20"))
        self.assertTrue(app._is_lan_host("10.0.0.4"))
        self.assertTrue(app._is_lan_host("fd00::20"))
        self.assertFalse(app._is_lan_host("8.8.8.8"))
        self.assertFalse(app._is_lan_host("example.com"))

    def test_login_me_logout(self):
        c = self.client()
        self.assertEqual(c.json("GET", "/api/me")[0], 401)
        status, body = c.login("owner", OWNER_PW)
        self.assertEqual((status, body), (200, {"id": "owner", "role": "owner"}))
        self.assertEqual(c.json("GET", "/api/me"), (200, {"id": "owner", "role": "owner"}))
        self.assertEqual(c.json("POST", "/api/logout", {})[0], 200)
        self.assertEqual(c.json("GET", "/api/me")[0], 401)

    def test_logout_revokes_server_side_even_with_old_cookie(self):
        c = self.owner()
        stolen = c.cookie
        c.json("POST", "/api/logout", {})
        other = self.client()
        other.cookie = stolen
        self.assertEqual(other.json("GET", "/api/me")[0], 401)

    def test_login_failure_is_401_without_revealing_which_field(self):
        c = self.client()
        s1, b1 = c.login("owner", "wrong-password")
        s2, b2 = c.login("ghost", "whatever-1234")
        self.assertEqual((s1, s2), (401, 401))
        self.assertEqual(b1["error"]["message"], b2["error"]["message"])
        self.assertIsNone(c.cookie)

    def test_login_validation(self):
        c = self.client()
        self.assertEqual(c.json("POST", "/api/login", {"id": "owner"})[0], 400)
        self.assertEqual(c.json("POST", "/api/login", ["x"])[0], 400)

    def test_cookie_attributes_http_only_samesite_strict_no_secure(self):
        c = self.client()
        _, _, _, set_cookie = c.request("POST", "/api/login", {"id": "owner", "password": OWNER_PW})
        parts = [p.strip() for p in set_cookie.split(";")]
        self.assertIn("HttpOnly", parts)
        self.assertIn("SameSite=Strict", parts)
        self.assertIn("Max-Age=43200", parts)
        self.assertIn("Path=/", parts)
        self.assertNotIn("Secure", [p.split("=")[0] for p in parts])  # HTTP 서버: Secure 금지

    def test_password_pbkdf2_310000_and_session_token_stored_as_hash(self):
        row = self.sql("SELECT salt, password_hash, iterations FROM users WHERE login_id='owner'")[0]
        self.assertEqual(row["iterations"], 310_000)
        self.assertEqual(app.PBKDF2_ITERATIONS, 310_000)
        self.assertEqual(len(row["salt"]), 32)
        self.assertNotIn(OWNER_PW, row["password_hash"])
        c = self.owner()
        token = c.cookie.split("=", 1)[1]
        hashes = [r["token_hash"] for r in self.sql("SELECT token_hash FROM sessions")]
        self.assertNotIn(token, hashes)
        self.assertIn(app.hashlib.sha256(token.encode()).hexdigest(), hashes)

    def test_session_expires_after_12_hours(self):
        c = self.owner()
        row = self.sql("SELECT created_at, expires_at FROM sessions ORDER BY created_at DESC LIMIT 1")[0]
        self.assertEqual(row["expires_at"] - row["created_at"], 12 * 3600)
        conn = app.connect(self.db)
        conn.execute("UPDATE sessions SET expires_at = 1")
        conn.close()
        self.assertEqual(c.json("GET", "/api/me")[0], 401)

    def test_wal_and_per_request_connection_pragmas(self):
        self.assertEqual(self.sql("PRAGMA journal_mode")[0][0], "wal")
        conn = app.connect(self.db)
        try:
            self.assertEqual(conn.execute("PRAGMA busy_timeout").fetchone()[0], 5000)
        finally:
            conn.close()

    def test_audit_log_records_login_events_without_secrets(self):
        c = self.client()
        c.login("owner", "wrong-password-x")
        c.login("owner", OWNER_PW)
        rows = self.sql("SELECT action, detail, login_id FROM audit_log")
        actions = {r["action"] for r in rows}
        self.assertTrue({"login_fail", "login_ok", "user_create"} <= actions)
        blob = json.dumps([tuple(r) for r in rows])
        self.assertNotIn(OWNER_PW, blob)
        self.assertNotIn("wrong-password-x", blob)

    def test_origin_check(self):
        c = self.client()
        s, _, _, _ = c.request("POST", "/api/login", {"id": "owner", "password": OWNER_PW}, {"Origin": "https://evil.example.com"})
        self.assertEqual(s, 403)
        s, _, _, _ = c.request("POST", "/api/login", {"id": "owner", "password": OWNER_PW}, {"Origin": "http://192.168.0.20:8787"})
        self.assertEqual(s, 200)
        s, _, _, _ = c.request("POST", "/api/login", {"id": "owner", "password": OWNER_PW}, {"Origin": "http://localhost:5173"})
        self.assertEqual(s, 200)

    def test_json_content_type_enforced(self):
        c = self.client()
        s, _, _, _ = c.request("POST", "/api/login", raw=b'{"id":"owner","password":"x"}', headers={"Content-Type": "text/plain"})
        self.assertEqual(s, 415)
        s, _, _, _ = c.request("POST", "/api/login", raw=b"{not json", headers={"Content-Type": "application/json"})
        self.assertEqual(s, 400)

    def test_body_limit_2mb(self):
        c = self.owner()
        big = b'{"baseVersion":0,"data":{"x":"' + b"a" * (2 * 1024 * 1024) + b'"}}'
        s, _, payload, _ = c.request("PUT", "/api/state", raw=big, headers={"Content-Type": "application/json"})
        self.assertEqual(s, 413)
        self.assertEqual(json.loads(payload)["error"]["code"], "PAYLOAD_TOO_LARGE")

    def test_unknown_api_and_method(self):
        c = self.owner()
        self.assertEqual(c.json("GET", "/api/nope")[0], 404)
        self.assertEqual(c.json("DELETE", "/api/state")[0], 405)


class RateLimitTests(ServerTestCase):
    max_failures = 5

    def test_login_rate_limit_then_blocks_even_correct_password(self):
        c = self.client()
        for _ in range(5):
            self.assertEqual(c.login("mom", "wrong-password-x")[0], 401)
        status, body = c.login("mom", "wrong-password-x")
        self.assertEqual(status, 429)
        self.assertGreater(body["retryAfterSec"], 0)
        self.assertEqual(c.login("mom", ADULT_PW)[0], 429)  # 맞는 비밀번호도 잠금 중에는 거부


class StateTests(ServerTestCase):
    max_failures = 1000

    def test_unauthenticated_is_401(self):
        c = self.client()
        for method, path, body in [
            ("GET", "/api/state", None),
            ("PUT", "/api/state", {"baseVersion": 0, "data": {}}),
            ("GET", "/api/backup", None),
            ("POST", "/api/restore", {}),
            ("GET", "/api/me", None),
        ]:
            self.assertEqual(c.json(method, path, body)[0], 401, f"{method} {path}")

    def test_adult_cannot_backup_or_restore_403(self):
        mom = self.adult()
        self.assertEqual(mom.json("GET", "/api/backup")[0], 403)
        doc = {"format": app.BACKUP_FORMAT, "schemaVersion": 1, "exportedAt": "2026-11-19T00:00:00Z", "data": {"a": 1}}
        self.assertEqual(mom.json("POST", "/api/restore", doc)[0], 403)
        # 일반 사용자도 state 읽기/쓰기는 가능
        self.assertEqual(mom.json("GET", "/api/state")[0], 200)

    def test_put_state_increments_version_and_get_returns_it(self):
        c = self.owner()
        _, cur = c.json("GET", "/api/state")
        s, put = c.json("PUT", "/api/state", {"baseVersion": cur["version"], "data": {"k": "한글"}})
        self.assertEqual(s, 200)
        self.assertEqual(put["version"], cur["version"] + 1)
        _, got = c.json("GET", "/api/state")
        self.assertEqual(got["data"], {"k": "한글"})
        self.assertEqual(got["version"], put["version"])
        _, meta = c.json("GET", "/api/state?meta=1")
        self.assertNotIn("data", meta)
        self.assertEqual(meta["version"], put["version"])

    def test_put_state_validation(self):
        c = self.owner()
        self.assertEqual(c.json("PUT", "/api/state", {"baseVersion": "0", "data": {}})[0], 400)
        self.assertEqual(c.json("PUT", "/api/state", {"baseVersion": True, "data": {}})[0], 400)
        self.assertEqual(c.json("PUT", "/api/state", {"baseVersion": 0, "data": [1]})[0], 400)

    def test_stale_base_version_returns_409_with_latest_version(self):
        a, b = self.owner(), self.adult()
        _, cur = a.json("GET", "/api/state")
        base = cur["version"]
        self.assertEqual(a.json("PUT", "/api/state", {"baseVersion": base, "data": {"by": "a"}})[0], 200)
        s, body = b.json("PUT", "/api/state", {"baseVersion": base, "data": {"by": "b"}})
        self.assertEqual(s, 409)
        self.assertEqual(body["error"]["code"], "VERSION_CONFLICT")
        self.assertEqual(body["version"], base + 1)
        self.assertEqual(a.json("GET", "/api/state")[1]["data"], {"by": "a"})  # 덮어쓰지 않았다

    def test_concurrent_same_base_version_only_one_wins(self):
        clients = [self.owner(), self.adult(), self.owner(), self.adult()]
        base = clients[0].json("GET", "/api/state")[1]["version"]
        results = []
        barrier = threading.Barrier(len(clients))

        def go(i, c):
            barrier.wait()
            results.append(c.json("PUT", "/api/state", {"baseVersion": base, "data": {"writer": i}})[0])

        threads = [threading.Thread(target=go, args=(i, c)) for i, c in enumerate(clients)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(sorted(results), [200, 409, 409, 409])
        self.assertEqual(clients[0].json("GET", "/api/state")[1]["version"], base + 1)

    def test_backup_change_restore_roundtrip(self):
        c = self.owner()
        original = {"families": [{"id": "f1", "name": "몽글네"}], "tasks": [1, 2, 3], "nested": {"a": None, "b": 1.5}}
        v = c.json("GET", "/api/state")[1]["version"]
        v = c.json("PUT", "/api/state", {"baseVersion": v, "data": original})[1]["version"]
        status, hdrs, payload, _ = c.request("GET", "/api/backup")
        self.assertEqual(status, 200)
        self.assertIn("attachment", hdrs["Content-Disposition"])
        backup = json.loads(payload)
        self.assertEqual(backup["format"], app.BACKUP_FORMAT)
        self.assertEqual(backup["schemaVersion"], 1)
        self.assertIn("exportedAt", backup)
        self.assertEqual(backup["data"], original)
        v = c.json("PUT", "/api/state", {"baseVersion": v, "data": {"changed": True}})[1]["version"]
        self.assertEqual(c.json("GET", "/api/state")[1]["data"], {"changed": True})
        s, res = c.json("POST", "/api/restore", backup)
        self.assertEqual(s, 200)
        self.assertEqual(res["version"], v + 1)  # version은 되감지 않는다
        _, after = c.json("GET", "/api/state")
        self.assertEqual(after["data"], original)
        # 복원 전 자동 백업 보관 + 감사 기록
        pre = self.sql("SELECT data FROM doc_backups WHERE reason='pre-restore' ORDER BY id DESC LIMIT 1")[0]
        self.assertEqual(json.loads(pre["data"]), {"changed": True})
        actions = [r["action"] for r in self.sql("SELECT action FROM audit_log")]
        self.assertIn("restore", actions)
        self.assertIn("backup", actions)

    def test_restore_rejects_bad_format_and_keeps_state(self):
        c = self.owner()
        before = c.json("GET", "/api/state")[1]
        for bad in [
            {"data": {}},
            {"format": "other", "schemaVersion": 1, "exportedAt": "x", "data": {}},
            {"format": app.BACKUP_FORMAT, "schemaVersion": 99, "exportedAt": "x", "data": {}},
            {"format": app.BACKUP_FORMAT, "schemaVersion": 1, "exportedAt": "x", "data": [1]},
        ]:
            self.assertEqual(c.json("POST", "/api/restore", bad)[0], 400)
        self.assertEqual(c.json("GET", "/api/state")[1], before)


class StaticTests(ServerTestCase):
    max_failures = 1000

    def get(self, path):
        return self.client().request("GET", path)

    def test_index_and_mime_types(self):
        for path, ctype in [
            ("/", "text/html; charset=utf-8"),
            ("/index.html", "text/html; charset=utf-8"),
            ("/assets/index-abc.js", "text/javascript; charset=utf-8"),
            ("/assets/index-abc.css", "text/css; charset=utf-8"),
            ("/icon.svg", "image/svg+xml"),
            ("/manifest.webmanifest", "application/manifest+json; charset=utf-8"),
        ]:
            status, hdrs, body, _ = self.get(path)
            self.assertEqual(status, 200, path)
            self.assertEqual(hdrs["Content-Type"], ctype, path)
            self.assertEqual(hdrs["X-Content-Type-Options"], "nosniff")
            self.assertTrue(body)
        _, hdrs, _, _ = self.get("/")
        self.assertIn("default-src 'self'", hdrs["Content-Security-Policy"])
        _, hdrs, _, _ = self.get("/assets/index-abc.js")
        self.assertIn("immutable", hdrs["Cache-Control"])

    def test_static_needs_no_login_but_api_does(self):
        self.assertEqual(self.get("/")[0], 200)
        self.assertEqual(self.client().json("GET", "/api/state")[0], 401)

    def test_head_request(self):
        status, hdrs, body, _ = self.client().request("HEAD", "/index.html")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertGreater(int(hdrs["Content-Length"]), 0)

    def test_missing_and_traversal_are_404(self):
        self.assertEqual(self.get("/nope.js")[0], 404)
        for p in ["/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/..%5csecret.txt"]:
            status, _, body, _ = self.get(p)
            self.assertIn(status, (400, 404), p)
            self.assertNotIn(b"TOP-SECRET", body)

    def test_hash_route_reload_serves_index(self):
        # 해시 라우트는 서버에 전달되지 않고 / 요청만 오므로 index.html이 내려오면 새로고침이 가능하다.
        status, _, body, _ = self.get("/?x=1")
        self.assertEqual(status, 200)
        self.assertIn(b'<div id=root>', body)

    def test_post_to_static_is_405(self):
        self.assertEqual(self.client().request("POST", "/index.html", raw=b"")[0], 405)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db = Path(self.tmp.name) / "h" / "family.sqlite3"

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, argv, passwords):
        err = io.StringIO()
        with mock.patch("getpass.getpass", side_effect=passwords) as gp, redirect_stderr(err), redirect_stdout_null():
            code = app.main(argv + ["--db", str(self.db)])
        return code, gp, err.getvalue()

    def test_init_admin_uses_getpass_twice_and_creates_owner(self):
        code, gp, _ = self.run_cli(["--init-admin", "owner"], ["cli-password-1", "cli-password-1"])
        self.assertEqual(code, 0)
        self.assertEqual(gp.call_count, 2)  # 비밀번호는 인자가 아니라 getpass로만 받는다
        conn = sqlite3.connect(str(self.db))
        try:
            row = conn.execute("SELECT role, iterations, password_hash FROM users WHERE login_id='owner'").fetchone()
        finally:
            conn.close()
        self.assertEqual(row[0], "owner")
        self.assertEqual(row[1], 310_000)
        self.assertNotIn("cli-password-1", row[2])

    def test_init_admin_mismatch_creates_nothing(self):
        code, _, err = self.run_cli(["--init-admin", "owner"], ["cli-password-1", "different-pass-2"])
        self.assertEqual(code, 1)
        conn = sqlite3.connect(str(self.db))
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0], 0)
        finally:
            conn.close()

    def test_init_admin_rejects_short_password_and_duplicate(self):
        self.assertEqual(self.run_cli(["--init-admin", "owner"], ["short", "short"])[0], 1)
        self.assertEqual(self.run_cli(["--init-admin", "owner"], ["cli-password-1"] * 2)[0], 0)
        self.assertEqual(self.run_cli(["--init-admin", "owner"], ["cli-password-1"] * 2)[0], 1)

    def test_no_password_option_exists(self):
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            app.main(["--init-admin", "owner", "--password", "x", "--db", str(self.db)])


class redirect_stdout_null:
    def __enter__(self):
        self._old = sys.stdout
        sys.stdout = io.StringIO()

    def __exit__(self, *a):
        sys.stdout = self._old


if __name__ == "__main__":
    unittest.main()
