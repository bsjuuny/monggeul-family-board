#!/usr/bin/env python3
"""몽글 패밀리보드 태블릿 서버 (명세 v1.3).

Python 표준 라이브러리만 사용한다: ThreadingHTTPServer + SQLite.
  - React dist/ 정적 파일과 /api/* 를 같은 포트(기본 8787)에서 제공한다.
  - 동일 Wi-Fi 전용이다. 인터넷 공개와 WAN 포트포워딩은 전제하지 않는다.
  - HTTP 서버이므로 세션 쿠키에 Secure 속성을 붙이지 않는다(붙이면 브라우저가 쿠키를 버린다).

사용:
    python tablet_server/app.py --init-admin owner        # 최초 owner (비밀번호는 getpass로 입력)
    python tablet_server/app.py --host 0.0.0.0 --port 8787
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import socket
import sqlite3
import sys
import threading
import time
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlsplit

SCHEMA_VERSION = 1
PBKDF2_ITERATIONS = 310_000
SESSION_TTL_SECONDS = 12 * 60 * 60
MAX_BODY_BYTES = 2 * 1024 * 1024
COOKIE_NAME = "mgfb_session"
BACKUP_FORMAT = "monggeul-family-board-backup"
BACKUP_SCHEMA_VERSION = 1
KEEP_AUTO_BACKUPS = 20
LOGIN_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
MIN_PASSWORD_LEN = 8
MAX_PASSWORD_LEN = 128

DEFAULT_DB_PATH = Path.home() / "monggeul-family-board-data" / "family.sqlite3"
DEFAULT_DIST_DIR = Path(__file__).resolve().parent.parent / "dist"

# Windows 레지스트리에 의존하지 않도록 MIME을 직접 지정한다.
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
}

HTML_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; "
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
)


# ───────────────────────── 설정 / 오류 ─────────────────────────


@dataclass
class Config:
    db_path: Path
    dist_dir: Path
    session_ttl: int = SESSION_TTL_SECONDS
    max_body: int = MAX_BODY_BYTES
    login_max_failures: int = 5
    login_ip_max_failures: int = 30
    login_window: int = 600


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, extra: Optional[Dict[str, Any]] = None,
                 headers: Optional[List[Tuple[str, str]]] = None, close: bool = False):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra or {}
        self.headers = headers or []
        self.close = close


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ───────────────────────── DB ─────────────────────────

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('owner','adult')),
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS family_doc (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS doc_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  login_id TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
"""


def connect(db_path: Path) -> sqlite3.Connection:
    """요청마다 새 연결을 연다. 호출자가 반드시 close 한다."""
    conn = sqlite3.connect(str(db_path), timeout=5.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(db_path.parent, 0o700)
    except OSError:
        pass  # Windows 등
    conn = connect(db_path)
    try:
        conn.executescript(SCHEMA_SQL)
        conn.execute("INSERT OR IGNORE INTO schema_meta(key, value) VALUES('schema_version', ?)", (str(SCHEMA_VERSION),))
        conn.execute(
            "INSERT OR IGNORE INTO family_doc(id, version, data, updated_at, updated_by) VALUES(1, 0, 'null', ?, NULL)",
            (now_iso(),),
        )
    finally:
        conn.close()


def audit(conn: sqlite3.Connection, login_id: Optional[str], action: str, detail: str = "") -> None:
    conn.execute("INSERT INTO audit_log(at, login_id, action, detail) VALUES(?,?,?,?)", (now_iso(), login_id, action, detail))


def hash_password(password: str, salt: bytes, iterations: int = PBKDF2_ITERATIONS) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations).hex()


def validate_new_credentials(login_id: str, password: str) -> None:
    if not LOGIN_ID_RE.match(login_id):
        raise ValueError("ID는 영문·숫자·_.- 3~32자여야 합니다.")
    if not (MIN_PASSWORD_LEN <= len(password) <= MAX_PASSWORD_LEN):
        raise ValueError(f"비밀번호는 {MIN_PASSWORD_LEN}~{MAX_PASSWORD_LEN}자여야 합니다.")


def create_user(db_path: Path, login_id: str, password: str, role: str = "adult") -> None:
    validate_new_credentials(login_id, password)
    if role not in ("owner", "adult"):
        raise ValueError("role은 owner 또는 adult")
    salt = secrets.token_bytes(16)
    conn = connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(
                "INSERT INTO users(login_id, role, salt, password_hash, iterations, created_at) VALUES(?,?,?,?,?,?)",
                (login_id, role, salt.hex(), hash_password(password, salt), PBKDF2_ITERATIONS, now_iso()),
            )
            audit(conn, login_id, "user_create", role)
            conn.execute("COMMIT")
        except sqlite3.IntegrityError:
            conn.execute("ROLLBACK")
            raise ValueError("이미 있는 ID입니다.")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()


# ───────────────────────── 로그인 속도 제한 ─────────────────────────


class RateLimiter:
    def __init__(self, window: int, per_id: int, per_ip: int):
        self.window = window
        self.per_id = per_id
        self.per_ip = per_ip
        self._lock = threading.Lock()
        self._fails: Dict[str, List[float]] = {}

    def _prune(self, key: str, now: float) -> List[float]:
        lst = [t for t in self._fails.get(key, []) if now - t < self.window]
        if lst:
            self._fails[key] = lst
        else:
            self._fails.pop(key, None)
        return lst

    def retry_after(self, ip: str, login_id: str) -> int:
        now = time.monotonic()
        with self._lock:
            wait = 0
            for key, limit in ((f"id|{ip}|{login_id.lower()}", self.per_id), (f"ip|{ip}", self.per_ip)):
                lst = self._prune(key, now)
                if len(lst) >= limit:
                    wait = max(wait, int(self.window - (now - lst[0])) + 1)
            return wait

    def record_failure(self, ip: str, login_id: str) -> None:
        now = time.monotonic()
        with self._lock:
            for key in (f"id|{ip}|{login_id.lower()}", f"ip|{ip}"):
                self._prune(key, now)
                self._fails.setdefault(key, []).append(now)

    def reset(self, ip: str, login_id: str) -> None:
        with self._lock:
            self._fails.pop(f"id|{ip}|{login_id.lower()}", None)


# ───────────────────────── HTTP ─────────────────────────


def _is_lan_host(host: str) -> bool:
    if host in ("localhost",) or host.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


def _split_host(host_header: str) -> str:
    h = host_header.strip()
    if h.startswith("["):
        return h[1:].split("]")[0].lower()
    return h.rsplit(":", 1)[0].lower() if h.count(":") == 1 else h.lower()


class FamilyServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: Tuple[str, int], config: Config):
        self.config = config
        self.limiter = RateLimiter(config.login_window, config.login_max_failures, config.login_ip_max_failures)
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = "MonggeulBoard/1.3"
    sys_version = ""
    server: FamilyServer  # type: ignore[assignment]

    # 접근 로그에는 경로만 남긴다 (body·쿠키·query 제외).
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D401
        try:
            line = f"{self.command} {urlsplit(self.path).path} {args[1] if len(args) > 1 else ''}"
        except Exception:
            line = "request"
        sys.stderr.write(f"[{self.log_date_time_string()}] {self.client_address[0]} {line}\n")

    # 메서드 진입
    def do_GET(self) -> None:
        self._handle("GET")

    def do_HEAD(self) -> None:
        self._handle("HEAD")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_PUT(self) -> None:
        self._handle("PUT")

    def do_DELETE(self) -> None:
        self._handle("DELETE")

    def do_PATCH(self) -> None:
        self._handle("PATCH")

    def do_OPTIONS(self) -> None:
        self._handle("OPTIONS")

    # ───── 공통 ─────
    def _handle(self, method: str) -> None:
        try:
            if not _is_lan_host(self.client_address[0]):
                raise ApiError(403, "LAN_ONLY", "같은 Wi-Fi의 기기에서만 접속할 수 있어요.")
            self._check_body_size()
            parts = urlsplit(self.path)
            if parts.path.startswith("/api/") or parts.path == "/api":
                self._check_origin()
                self._api(method, parts.path, parse_qs(parts.query))
            elif method in ("GET", "HEAD"):
                self._static(parts.path, head=method == "HEAD")
            else:
                raise ApiError(405, "METHOD_NOT_ALLOWED", "허용되지 않는 메서드예요.", headers=[("Allow", "GET, HEAD")])
        except ApiError as e:
            self._send_error(e)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:  # 내부 오류 상세는 응답에 싣지 않는다
            traceback.print_exc(file=sys.stderr)
            self._send_error(ApiError(500, "INTERNAL_ERROR", "서버 내부 오류예요."))

    def _check_body_size(self) -> None:
        cl = self.headers.get("Content-Length")
        if cl is not None:
            try:
                n = int(cl)
            except ValueError:
                raise ApiError(400, "BAD_REQUEST", "Content-Length가 올바르지 않아요.", close=True)
            if n < 0:
                raise ApiError(400, "BAD_REQUEST", "Content-Length가 올바르지 않아요.", close=True)
            if n > self.server.config.max_body:
                # 클라이언트가 응답을 읽을 수 있도록 적당한 크기까지는 버리고 응답한다(저장하지 않음).
                left = n if n <= 8 * self.server.config.max_body else 0
                while left > 0:
                    chunk = self.rfile.read(min(65536, left))
                    if not chunk:
                        break
                    left -= len(chunk)
                raise ApiError(413, "PAYLOAD_TOO_LARGE", "요청 본문은 2MB까지 허용돼요.", close=True)

    def _check_origin(self) -> None:
        origin = self.headers.get("Origin")
        if origin is None:
            return
        host = (urlsplit(origin).hostname or "").lower()
        req_host = _split_host(self.headers.get("Host", ""))
        if origin == "null" or not host or not (host == req_host or _is_lan_host(host)):
            raise ApiError(403, "FORBIDDEN", "허용되지 않은 출처예요.")

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding"):
            raise ApiError(411, "LENGTH_REQUIRED", "Content-Length가 필요해요.", close=True)
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type은 application/json이어야 해요.")
        cl = self.headers.get("Content-Length")
        if cl is None:
            raise ApiError(411, "LENGTH_REQUIRED", "Content-Length가 필요해요.", close=True)
        n = int(cl)
        raw = self.rfile.read(n) if n else b""
        if len(raw) != n:
            raise ApiError(400, "BAD_REQUEST", "본문이 완전하지 않아요.", close=True)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ApiError(400, "INVALID_JSON", "JSON 형식이 올바르지 않아요.")

    def _send(self, status: int, body: bytes, ctype: str, headers: Optional[List[Tuple[str, str]]] = None,
              head: bool = False, close: bool = False) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        for k, v in headers or []:
            self.send_header(k, v)
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def _send_json(self, status: int, obj: Any, headers: Optional[List[Tuple[str, str]]] = None) -> None:
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        hs = [("Cache-Control", "no-store")] + (headers or [])
        self._send(status, body, "application/json; charset=utf-8", hs)

    def _send_error(self, e: ApiError) -> None:
        payload: Dict[str, Any] = {"error": {"code": e.code, "message": e.message}}
        payload.update(e.extra)
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        hs = [("Cache-Control", "no-store")] + e.headers
        try:
            self._send(e.status, body, "application/json; charset=utf-8", hs, close=e.close)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ───── 쿠키 / 세션 ─────
    def _cookie_header(self, token: str, max_age: int) -> Tuple[str, str]:
        # HTTP 서버이므로 Secure를 붙이지 않는다.
        extra = "" if max_age > 0 else "; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
        return ("Set-Cookie", f"{COOKIE_NAME}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict{extra}")

    def _token(self) -> Optional[str]:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        try:
            c = SimpleCookie()
            c.load(raw)
        except Exception:
            return None
        m = c.get(COOKIE_NAME)
        return m.value if m and m.value else None

    def _auth(self, conn: sqlite3.Connection) -> sqlite3.Row:
        token = self._token()
        if token:
            h = hashlib.sha256(token.encode("utf-8")).hexdigest()
            row = conn.execute(
                "SELECT u.id, u.login_id, u.role, s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id "
                "WHERE s.token_hash = ? AND s.expires_at > ?",
                (h, int(time.time())),
            ).fetchone()
            if row:
                return row
        raise ApiError(401, "UNAUTHENTICATED", "로그인이 필요해요.", headers=[self._cookie_header("", 0)] if token else None)

    def _require_owner(self, user: sqlite3.Row) -> None:
        if user["role"] != "owner":
            raise ApiError(403, "FORBIDDEN", "owner만 할 수 있어요.")

    # ───── API ─────
    def _api(self, method: str, path: str, query: Dict[str, List[str]]) -> None:
        routes = {
            "/api/health": {"GET": self._health},
            "/api/login": {"POST": self._login},
            "/api/logout": {"POST": self._logout},
            "/api/me": {"GET": self._me},
            "/api/state": {"GET": self._state_get, "PUT": self._state_put},
            "/api/backup": {"GET": self._backup},
            "/api/restore": {"POST": self._restore},
        }
        table = routes.get(path)
        if table is None:
            raise ApiError(404, "NOT_FOUND", "없는 API예요.")
        if method == "HEAD":
            method = "GET"
        fn = table.get(method)
        if fn is None:
            raise ApiError(405, "METHOD_NOT_ALLOWED", "허용되지 않는 메서드예요.", headers=[("Allow", ", ".join(table))])
        conn = connect(self.server.config.db_path)
        try:
            fn(conn, query)
        finally:
            conn.close()

    def _health(self, conn: sqlite3.Connection, query: Dict[str, List[str]]) -> None:
        conn.execute("SELECT 1").fetchone()
        self._send_json(200, {"status": "ok", "schemaVersion": SCHEMA_VERSION, "serverTime": now_iso()})

    def _login(self, conn: sqlite3.Connection, query: Dict[str, List[str]]) -> None:
        cfg = self.server.config
        body = self._read_json()
        if not isinstance(body, dict):
            raise ApiError(400, "VALIDATION_ERROR", "ID와 비밀번호를 보내 주세요.")
        login_id, password = body.get("id"), body.get("password")
        if not isinstance(login_id, str) or not isinstance(password, str) or not login_id or len(login_id) > 64 or len(password) > MAX_PASSWORD_LEN:
            raise ApiError(400, "VALIDATION_ERROR", "ID와 비밀번호를 확인해 주세요.")
        ip = self.client_address[0]
        wait = self.server.limiter.retry_after(ip, login_id)
        if wait > 0:
            audit(conn, login_id, "login_blocked", ip)
            raise ApiError(429, "RATE_LIMITED", "로그인 시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.",
                           {"retryAfterSec": wait}, headers=[("Retry-After", str(wait))])
        row = conn.execute("SELECT * FROM users WHERE login_id = ?", (login_id,)).fetchone()
        if row:
            digest = hash_password(password, bytes.fromhex(row["salt"]), row["iterations"])
            ok = hmac.compare_digest(digest, row["password_hash"])
        else:
            # 존재 여부가 응답 시간으로 드러나지 않도록 같은 비용의 해시를 계산한다.
            hmac.compare_digest(hash_password(password, b"\0" * 16), "0" * 64)
            ok = False
        if not ok:
            self.server.limiter.record_failure(ip, login_id)
            audit(conn, login_id, "login_fail", ip)
            raise ApiError(401, "UNAUTHENTICATED", "ID 또는 비밀번호가 올바르지 않아요.", {"reason": "BAD_CREDENTIALS"})
        self.server.limiter.reset(ip, login_id)
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
        conn.execute(
            "INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)",
            (hashlib.sha256(token.encode("utf-8")).hexdigest(), row["id"], now, now + cfg.session_ttl),
        )
        audit(conn, row["login_id"], "login_ok", ip)
        self._send_json(200, {"id": row["login_id"], "role": row["role"]}, [self._cookie_header(token, cfg.session_ttl)])

    def _logout(self, conn: sqlite3.Connection, query: Dict[str, List[str]]) -> None:
        token = self._token()
        if token:
            h = hashlib.sha256(token.encode("utf-8")).hexdigest()
            row = conn.execute("SELECT u.login_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", (h,)).fetchone()
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (h,))
            if row:
                audit(conn, row["login_id"], "logout")
        self._send_json(200, {"ok": True}, [self._cookie_header("", 0)])

    def _me(self, conn: sqlite3.Connection, query: Dict[str, List[str]]) -> None:
        u = self._auth(conn)
        self._send_json(200, {"id": u["login_id"], "role": u["role"]})

    def _state_get(self, conn: sqlite3.Connection, query: Dict[str, List[str]]) -> None:
        self._auth(conn)
        row = conn.execute("SELECT version, data, updated_at FROM family_doc WHERE id = 1").fetchone()
        out: Dict[str, Any] = {"version": row["version"], "updatedAt": row["updated_at"]}
        if query.get("meta", ["0"])[0] != "1":
            out["data"] = json.loads(row["data"])
        self._send_json(200, out)

    def _state_put(self, conn: sqlite3.Connection, query: Dict[str, List[str]]) -> None:
        u = self._auth(conn)
        body = self._read_json()
        if not isinstance(body, dict):
            raise ApiError(400, "VALIDATION_ERROR", "baseVersion과 data가 필요해요.")
        base, data = body.get("baseVersion"), body.get("data")
        if not isinstance(base, int) or isinstance(base, bool) or base < 0:
            raise ApiError(400, "VALIDATION_ERROR", "baseVersion은 0 이상의 정수여야 해요.")
        if not isinstance(data, dict):
            raise ApiError(400, "VALIDATION_ERROR", "data는 JSON 객체여야 해요.")
        text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        stamp = now_iso()
        conn.execute("BEGIN IMMEDIATE")
        try:
            cur = conn.execute(
                "UPDATE family_doc SET version = version + 1, data = ?, updated_at = ?, updated_by = ? WHERE id = 1 AND version = ?",
                (text, stamp, u["login_id"], base),
            )
            if cur.rowcount == 0:
                row = conn.execute("SELECT version, updated_at FROM family_doc WHERE id = 1").fetchone()
                conn.execute("ROLLBACK")
                raise ApiError(409, "VERSION_CONFLICT", "다른 기기가 먼저 저장했어요.",
                               {"version": row["version"], "updatedAt": row["updated_at"]})
            version = conn.execute("SELECT version FROM family_doc WHERE id = 1").fetchone()["version"]
            conn.execute("COMMIT")
        except ApiError:
            raise
        except Exception:
            conn.execute("ROLLBACK")
            raise
        self._send_json(200, {"version": version, "updatedAt": stamp})

    def _backup(self, conn: sqlite3.Connection, query: Dict[str, List[str]]) -> None:
        u = self._auth(conn)
        self._require_owner(u)
        row = conn.execute("SELECT version, data FROM family_doc WHERE id = 1").fetchone()
        audit(conn, u["login_id"], "backup", f"v{row['version']}")
        stamp = now_iso()
        doc = {
            "format": BACKUP_FORMAT,
            "schemaVersion": BACKUP_SCHEMA_VERSION,
            "exportedAt": stamp,
            "data": json.loads(row["data"]),
        }
        fname = "monggeul-backup-" + re.sub(r"[^0-9]", "", stamp)[:14] + ".json"
        self._send_json(200, doc, [("Content-Disposition", f'attachment; filename="{fname}"')])

    def _restore(self, conn: sqlite3.Connection, query: Dict[str, List[str]]) -> None:
        u = self._auth(conn)
        self._require_owner(u)
        body = self._read_json()
        if (not isinstance(body, dict) or body.get("format") != BACKUP_FORMAT
                or body.get("schemaVersion") != BACKUP_SCHEMA_VERSION or not isinstance(body.get("exportedAt"), str)
                or not isinstance(body.get("data"), dict)):
            raise ApiError(400, "VALIDATION_ERROR", "백업 파일 형식이 올바르지 않아요.")
        text = json.dumps(body["data"], ensure_ascii=False, separators=(",", ":"))
        stamp = now_iso()
        conn.execute("BEGIN IMMEDIATE")
        try:
            cur = conn.execute("SELECT version, data FROM family_doc WHERE id = 1").fetchone()
            conn.execute(
                "INSERT INTO doc_backups(created_at, reason, version, data) VALUES(?,?,?,?)",
                (stamp, "pre-restore", cur["version"], cur["data"]),
            )
            conn.execute(
                "DELETE FROM doc_backups WHERE id NOT IN (SELECT id FROM doc_backups ORDER BY id DESC LIMIT ?)",
                (KEEP_AUTO_BACKUPS,),
            )
            version = cur["version"] + 1
            conn.execute(
                "UPDATE family_doc SET version = ?, data = ?, updated_at = ?, updated_by = ? WHERE id = 1",
                (version, text, stamp, u["login_id"]),
            )
            audit(conn, u["login_id"], "restore", f"v{cur['version']}->v{version}")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        self._send_json(200, {"version": version, "updatedAt": stamp})

    # ───── 정적 파일 ─────
    def _static(self, raw_path: str, head: bool) -> None:
        dist = self.server.config.dist_dir.resolve()
        rel = unquote(raw_path)
        if "\0" in rel:
            raise ApiError(400, "BAD_REQUEST", "잘못된 경로예요.")
        rel = rel.lstrip("/\\")
        parts = [p for p in re.split(r"[\\/]+", rel) if p]
        if any(p.startswith(".") for p in parts):
            raise ApiError(404, "NOT_FOUND", "찾을 수 없어요.")
        target = (dist / "/".join(parts)).resolve() if parts else dist / "index.html"
        try:
            inside = target == dist or target.is_relative_to(dist)
        except AttributeError:  # pragma: no cover - 3.8
            inside = str(target).startswith(str(dist))
        if not inside:
            raise ApiError(404, "NOT_FOUND", "찾을 수 없어요.")
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            if not (dist / "index.html").is_file() and not parts:
                raise ApiError(503, "DIST_MISSING", "dist/가 없어요. 'npm run build'로 만든 dist 폴더를 두세요.")
            raise ApiError(404, "NOT_FOUND", "찾을 수 없어요.")
        ext = target.suffix.lower()
        ctype = MIME_TYPES.get(ext, "application/octet-stream")
        data = target.read_bytes()
        headers: List[Tuple[str, str]] = []
        if ext == ".html":
            headers.append(("Content-Security-Policy", HTML_CSP))
        if "assets" in parts[:1]:
            headers.append(("Cache-Control", "public, max-age=31536000, immutable"))
        else:
            headers.append(("Cache-Control", "no-cache"))
        self._send(200, data, ctype, headers, head=head)


# ───────────────────────── 실행 ─────────────────────────


def make_server(config: Config, host: str = "127.0.0.1", port: int = 0) -> FamilyServer:
    init_db(config.db_path)
    conn = connect(config.db_path)
    try:
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))
    finally:
        conn.close()
    return FamilyServer((host, port), config)


def _lan_ip() -> Optional[str]:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("10.255.255.255", 1))  # 패킷은 전송되지 않는다
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        return None


def _prompt_user(login_id: str, role: str, db_path: Path) -> int:
    init_db(db_path)
    try:
        validate_new_credentials(login_id, "x" * MIN_PASSWORD_LEN)
        pw = getpass.getpass(f"'{login_id}' 비밀번호({MIN_PASSWORD_LEN}자 이상): ")
        again = getpass.getpass("비밀번호 다시 입력: ")
        if pw != again:
            print("비밀번호가 서로 달라요. 계정을 만들지 않았어요.", file=sys.stderr)
            return 1
        create_user(db_path, login_id, pw, role)
    except ValueError as e:
        print(f"오류: {e}", file=sys.stderr)
        return 1
    print(f"{role} 계정 '{login_id}'을(를) 만들었어요. DB: {db_path}")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="몽글 패밀리보드 태블릿 서버")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--db", default=os.environ.get("MGFB_DB", str(DEFAULT_DB_PATH)), help="SQLite 파일 경로")
    ap.add_argument("--dist", default=os.environ.get("MGFB_DIST", str(DEFAULT_DIST_DIR)), help="React dist 폴더")
    ap.add_argument("--init-admin", metavar="ID", help="owner 계정 생성(비밀번호는 getpass로 입력)")
    ap.add_argument("--add-user", metavar="ID", help="성인(adult) 계정 생성(비밀번호는 getpass로 입력)")
    args = ap.parse_args(argv)
    db_path = Path(args.db).expanduser()
    if args.init_admin:
        return _prompt_user(args.init_admin, "owner", db_path)
    if args.add_user:
        return _prompt_user(args.add_user, "adult", db_path)

    config = Config(db_path=db_path, dist_dir=Path(args.dist).expanduser())
    server = make_server(config, args.host, args.port)
    conn = connect(db_path)
    try:
        has_owner = conn.execute("SELECT 1 FROM users WHERE role = 'owner' LIMIT 1").fetchone() is not None
    finally:
        conn.close()
    port = server.server_address[1]
    print(f"몽글 패밀리보드 서버: http://{args.host}:{port}  (DB: {db_path}, dist: {config.dist_dir})")
    ip = _lan_ip()
    if ip and args.host in ("0.0.0.0", ""):
        print(f"같은 Wi-Fi 기기에서는 http://{ip}:{port} 로 접속하세요. 공유기 WAN 포트포워딩은 설정하지 마세요.")
    if not has_owner:
        print("owner 계정이 없어요. 먼저: python tablet_server/app.py --init-admin ID", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
