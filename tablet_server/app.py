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
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import board  # noqa: E402
import board_store as bs  # noqa: E402
import kidsnote  # noqa: E402
import migrations  # noqa: E402
from analyzer_bridge import NodeAnalyzer  # noqa: E402
from weather import WeatherService, delete_key, key_source, latlon_to_grid, save_key  # noqa: E402
import radio  # noqa: E402

SCHEMA_VERSION = 1  # 기본 테이블(v1) 버전. 이후 변경은 migrations.py 가 올린다.
PBKDF2_ITERATIONS = 310_000
SESSION_TTL_SECONDS = 12 * 60 * 60
MAX_BODY_BYTES = 2 * 1024 * 1024
COOKIE_NAME = "mgfb_session"
DEVICE_COOKIE_NAME = "mgfb_device"
SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60  # 쓰는 동안 세션을 연장해도 30일을 넘기지 않는다
BACKUP_FORMAT = "monggeul-family-board-backup"
BACKUP_SCHEMA_VERSION = 1
KEEP_AUTO_BACKUPS = 20
# JSON 백업에 함께 넣는 v2 표(공지 원문·이력·기기·캐시는 넣지 않는다)
V2_BACKUP_TABLES = ("settings", "notices", "prep_items", "commute_exceptions", "notice_events", "pickups")
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
    notice_source: Optional[str] = None  # 'mock:<파일>' 이면 모의 공지 수집(개발·QA 전용)
    analyzer: Optional[Any] = None
    allow_remote_key_entry: bool = False  # 테스트 전용: 루프백이 아닌 곳에서도 키 입력 허용
    weather_fetcher: Optional[Callable[[str], Any]] = None
    radio_fetcher: Optional[Callable[..., Any]] = None  # 테스트용 가짜 radio-cast


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


def init_db(db_path: Path, log: Callable[[str], None] = lambda s: None) -> Optional[Path]:
    """v1 기본 테이블을 만들고, 남은 마이그레이션을 적용한다(적용 전 DB 파일을 백업). 백업 경로를 돌려준다."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(db_path.parent, 0o700)
    except OSError:
        pass  # Windows 등
    existed = db_path.exists() and db_path.stat().st_size > 0
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
    # 새로 만든 빈 DB는 백업할 내용이 없다
    return migrations.migrate(db_path, connect, log, backup=existed)


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


def key_entry_allowed(client_ip: str, config: "Config") -> bool:
    """기상청 키 입력은 태블릿 자신(루프백)에서 온 요청만 받는다(평문 HTTP로 Wi-Fi에 키가 오가지 않게)."""
    try:
        return ipaddress.ip_address(client_ip).is_loopback or config.allow_remote_key_entry
    except ValueError:
        return False


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
        self.pair_limiter = RateLimiter(600, 10, 30)
        data_dir = config.db_path.parent
        self.weather = WeatherService(data_dir, config.weather_fetcher) if config.weather_fetcher else WeatherService(data_dir)
        self.radio = radio.RadioClient(data_dir, config.radio_fetcher)
        self.adapter = kidsnote.adapter_from_spec(config.notice_source)
        self.analyzer = config.analyzer or NodeAnalyzer()
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
        self._extra_headers: List[Tuple[str, str]] = []
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
            limit = self.server.config.max_body * (5 if urlsplit(self.path).path == "/api/restore" else 1)  # 백업 파일은 10MB까지
            if n > limit:
                # 클라이언트가 응답을 읽을 수 있도록 적당한 크기까지는 버리고 응답한다(저장하지 않음).
                left = n if n <= 8 * limit else 0
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
        for k, v in (headers or []) + getattr(self, "_extra_headers", []):
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

    def _device_cookie_header(self, token: str, max_age: int) -> Tuple[str, str]:
        extra = "" if max_age > 0 else "; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
        return ("Set-Cookie", f"{DEVICE_COOKIE_NAME}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict{extra}")

    def _token(self, name: str = COOKIE_NAME) -> Optional[str]:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        try:
            c = SimpleCookie()
            c.load(raw)
        except Exception:
            return None
        m = c.get(name)
        return m.value if m and m.value else None

    def _auth(self, conn: sqlite3.Connection, clear_on_fail: bool = True) -> sqlite3.Row:
        token = self._token()
        if token:
            h = hashlib.sha256(token.encode("utf-8")).hexdigest()
            now = int(time.time())
            row = conn.execute(
                "SELECT u.id, u.login_id, u.role, s.token_hash, s.created_at, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id "
                "WHERE s.token_hash = ? AND s.expires_at > ?",
                (h, now),
            ).fetchone()
            if row:
                ttl = self.server.config.session_ttl
                # 쓰는 동안은 세션을 연장한다(남은 시간이 절반 아래일 때, 처음 로그인 뒤 30일까지)
                if row["expires_at"] - now < ttl // 2 and now + ttl <= row["created_at"] + SESSION_MAX_AGE_SECONDS:
                    conn.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", (now + ttl, h))
                    self._extra_headers.append(self._cookie_header(token, ttl))
                return row
        raise ApiError(401, "UNAUTHENTICATED", "로그인이 필요해요.",
                       headers=[self._cookie_header("", 0)] if token and clear_on_fail else None)

    def _principal(self, conn: sqlite3.Connection, allow_device: bool) -> Dict[str, Any]:
        """성인 세션 또는 (허용된 API에서만) TV 기기 토큰."""
        if self._token():
            try:
                u = self._auth(conn, clear_on_fail=not allow_device)
                return {"kind": "user", "user": u, "actor": u["login_id"]}
            except ApiError:
                if not allow_device:
                    raise
        if allow_device:
            dev_token = self._token(DEVICE_COOKIE_NAME)
            dev = bs.device_for_token(conn, dev_token)
            if dev is not None:
                # 쓰는 동안 브라우저 쿠키 수명도 늘린다(서버 만료와 함께 연장)
                self._extra_headers.append(self._device_cookie_header(dev_token, bs.DEVICE_COOKIE_MAX_AGE))
                return {"kind": "device", "device": dev, "actor": f"device:{dev['id']}"}
        raise ApiError(401, "UNAUTHENTICATED", "로그인이 필요해요.")

    def _user(self, conn: sqlite3.Connection) -> Dict[str, Any]:
        return self._principal(conn, allow_device=False)

    def _require_owner(self, user: sqlite3.Row) -> None:
        if user["role"] != "owner":
            raise ApiError(403, "FORBIDDEN", "owner만 할 수 있어요.")

    # ───── API ─────
    def _api(self, method: str, path: str, query: Dict[str, List[str]]) -> None:
        if method == "HEAD":
            method = "GET"
        allowed: List[str] = []
        for m, pattern, name in ROUTES:
            match = pattern.fullmatch(path)
            if not match:
                continue
            if m != method:
                allowed.append(m)
                continue
            conn = connect(self.server.config.db_path)
            try:
                try:
                    getattr(self, name)(conn, query, *match.groups())
                except bs.StoreError as e:
                    raise ApiError(e.status, e.code, e.message, e.extra)
                except radio.RadioError as e:
                    raise ApiError(e.status, e.code, e.message)
            finally:
                conn.close()
            return
        if allowed:
            raise ApiError(405, "METHOD_NOT_ALLOWED", "허용되지 않는 메서드예요.", headers=[("Allow", ", ".join(sorted(set(allowed))))])
        raise ApiError(404, "NOT_FOUND", "없는 API예요.")

    @staticmethod
    def _q(query: Dict[str, List[str]], name: str) -> Optional[str]:
        v = query.get(name)
        return v[0] if v else None

    def _range(self, query: Dict[str, List[str]], default_days: int = 1) -> Tuple[str, str]:
        start = self._q(query, "from") or bs.today_kst()
        end = self._q(query, "to") or bs.add_days(start, default_days)
        if not (bs.DATE_RE.match(start) and bs.DATE_RE.match(end)) or end < start or bs.add_days(start, 62) < end:
            raise ApiError(400, "VALIDATION_ERROR", "기간(from·to, 최대 62일)을 확인해 주세요.")
        return start, end

    def _health(self, conn: sqlite3.Connection, query: Dict[str, List[str]]) -> None:
        conn.execute("SELECT 1").fetchone()
        self._send_json(200, {"status": "ok", "schemaVersion": migrations.current_version(conn), "serverTime": now_iso()})

    # ───── v2: 설정 ─────
    def _settings_get(self, conn, query) -> None:
        self._user(conn)
        s = bs.get_settings(conn)
        loc = s.get("location")
        s["weatherKeyConfigured"] = self.server.weather.key_configured()
        s["weatherKeySource"] = key_source(self.server.config.db_path.parent)
        s["radioKeySource"] = radio.key_source(self.server.config.db_path.parent)
        if loc:
            s["location"] = {**loc, "grid": list(latlon_to_grid(loc["lat"], loc["lon"]))}
        self._send_json(200, s)

    def _settings_put(self, conn, query, key) -> None:
        p = self._user(conn)
        body = self._read_json()
        if not isinstance(body, dict):
            raise ApiError(400, "VALIDATION_ERROR", "value와 baseVersion이 필요해요.")
        if key in ("kidsnote", "notices") and p["user"]["role"] != "owner":
            raise ApiError(403, "FORBIDDEN", "공지·키즈노트 설정은 owner만 바꿀 수 있어요.")
        res = bs.put_setting(conn, key, body.get("value"), body.get("baseVersion"), p["actor"])
        audit(conn, p["actor"], "settings", key)
        self._send_json(200, res)

    def _weather_key_put(self, conn, query) -> None:
        """owner 가 설정 화면에서 기상청 키를 넣는다. 먼저 시험 호출하고, 키가 틀리면 저장하지 않는다. 키는 응답·로그에 남기지 않는다."""
        p = self._user(conn)
        if p["user"]["role"] != "owner":
            raise ApiError(403, "FORBIDDEN", "기상청 키는 owner만 넣을 수 있어요.")
        if not key_entry_allowed(self.client_address[0], self.server.config):
            raise ApiError(403, "LOCAL_ONLY", "키가 Wi-Fi로 오가지 않도록 태블릿에서 직접 http://127.0.0.1:8787 을 열어 넣어 주세요.")
        if key_source(self.server.config.db_path.parent) == "env":
            raise ApiError(409, "KEY_FROM_ENV", "지금은 서버 환경변수(MGFB_KMA_KEY)의 키를 쓰고 있어요. 환경변수를 지운 뒤 다시 넣어 주세요.")
        body = self._read_json()
        key = body.get("key") if isinstance(body, dict) else None
        if not isinstance(key, str) or not key.strip() or len(key.strip()) > 400 or any(c.isspace() for c in key.strip()):
            raise ApiError(400, "VALIDATION_ERROR", "공공데이터포털에서 받은 서비스 키(Decoding 키)를 그대로 붙여넣어 주세요.")
        loc = bs.get_settings(conn)["location"]
        nx, ny = latlon_to_grid(loc["lat"], loc["lon"]) if loc else (60, 127)
        result, message = self.server.weather.test_key(key.strip(), nx, ny)
        if result == "invalid":
            audit(conn, p["actor"], "weather_key_rejected")
            raise ApiError(400, "WEATHER_KEY_INVALID", f"{message} 키를 저장하지 않았어요.")
        if result == "unreachable":  # 확인하지 못한 키로 기존 키를 덮어쓰지 않는다
            audit(conn, p["actor"], "weather_key_unverified")
            raise ApiError(503, "WEATHER_UNREACHABLE", f"지금 기상청에 연결할 수 없어 키를 확인하지 못했어요({message}). 태블릿 인터넷을 확인한 뒤 다시 시도해 주세요. 키는 저장하지 않았어요.")
        save_key(self.server.config.db_path.parent, key.strip())
        self.server.weather.reset_failures()
        if loc:
            self.server.weather.refresh(conn, nx, ny, force=True)
        audit(conn, p["actor"], "weather_key_set", result)
        self._send_json(200, {"saved": True, "check": result, "message": message})

    def _weather_key_delete(self, conn, query) -> None:
        p = self._user(conn)
        if p["user"]["role"] != "owner":
            raise ApiError(403, "FORBIDDEN", "기상청 키는 owner만 지울 수 있어요.")
        removed = delete_key(self.server.config.db_path.parent)
        audit(conn, p["actor"], "weather_key_deleted")
        self._send_json(200, {"removed": removed})

    # ───── v2: 라디오(미니PC radio-cast 대신 부르기) ─────
    def _radio_settings(self, conn) -> Dict[str, Any]:
        return bs.get_settings(conn)["radio"]

    def _radio_key_put(self, conn, query) -> None:
        """owner 가 태블릿(루프백)에서 radio-cast 비밀번호를 넣는다. 먼저 시험 호출해 맞을 때만 저장하고, 응답·로그에 남기지 않는다."""
        p = self._user(conn)
        if p["user"]["role"] != "owner":
            raise ApiError(403, "FORBIDDEN", "라디오 비밀번호는 owner만 넣을 수 있어요.")
        if not key_entry_allowed(self.client_address[0], self.server.config):
            raise ApiError(403, "LOCAL_ONLY", "비밀번호가 Wi-Fi로 오가지 않도록 태블릿에서 직접 http://127.0.0.1:8787 을 열어 넣어 주세요.")
        if radio.key_source(self.server.config.db_path.parent) == "env":
            raise ApiError(409, "KEY_FROM_ENV", "지금은 서버 환경변수(MGFB_RADIO_KEY)의 비밀번호를 쓰고 있어요.")
        body = self._read_json()
        key = body.get("key") if isinstance(body, dict) else None
        if not isinstance(key, str) or not key.strip() or len(key.strip()) > 200:
            raise ApiError(400, "VALIDATION_ERROR", "radio-cast 비밀번호를 넣어 주세요.")
        # 틀리면 RadioError 가 나서 저장하지 않는다
        self.server.radio.call(self._radio_settings(conn).get("baseUrl"), "/api/stations", key=key.strip())
        radio.save_key(self.server.config.db_path.parent, key.strip())
        audit(conn, p["actor"], "radio_key_saved")
        self._send_json(200, {"saved": True})

    def _radio_key_delete(self, conn, query) -> None:
        p = self._user(conn)
        if p["user"]["role"] != "owner":
            raise ApiError(403, "FORBIDDEN", "라디오 비밀번호는 owner만 지울 수 있어요.")
        removed = radio.delete_key(self.server.config.db_path.parent)
        audit(conn, p["actor"], "radio_key_deleted")
        self._send_json(200, {"removed": removed})

    def _radio_stations(self, conn, query) -> None:
        self._user(conn)
        res = self.server.radio.call(self._radio_settings(conn).get("baseUrl"), "/api/stations")
        self._send_json(200, {"stations": res if isinstance(res, list) else []})

    def _radio_devices(self, conn, query) -> None:
        self._user(conn)
        refresh = "1" if (query.get("refresh") or [""])[0] == "1" else None
        res = self.server.radio.call(self._radio_settings(conn).get("baseUrl"), "/api/devices", {"refresh": refresh})
        self._send_json(200, res if isinstance(res, dict) else {"devices": []})

    def _radio_status(self, conn, query) -> None:
        self._user(conn)
        st = self._radio_settings(conn)
        dev = radio.check_device((query.get("device") or [""])[0]) or st.get("defaultDevice")
        self._send_json(200, self.server.radio.call(st.get("baseUrl"), "/status", {"device": dev}))

    def _radio_stream(self, conn, query) -> None:
        """태블릿 자체 스피커용: 방송 주소만 받아 온다(KBS·MBC·SBS 는 토큰 때문에 매번 새로)."""
        self._user(conn)
        sid = radio.check_station((query.get("station") or [""])[0])
        res = self.server.radio.call(self._radio_settings(conn).get("baseUrl"), "/stream", {"station": sid})
        url = res.get("url") if isinstance(res, dict) else None
        if not isinstance(url, str) or not url.startswith("https://"):
            raise ApiError(502, "RADIO_ERROR", "방송 주소를 받지 못했어요.")
        self._send_json(200, {"station": sid, "title": res.get("title"), "url": url})

    def _radio_play(self, conn, query) -> None:
        p = self._user(conn)
        body = self._read_json()
        body = body if isinstance(body, dict) else {}
        st = self._radio_settings(conn)
        sid = radio.check_station(body.get("station"))
        dev = radio.check_device(body.get("device")) or st.get("defaultDevice")
        res = self.server.radio.call(st.get("baseUrl"), "/play", {"station": sid, "device": dev})
        audit(conn, p["actor"], "radio_play", sid)
        self._send_json(200, res)

    def _radio_stop(self, conn, query) -> None:
        self._user(conn)
        body = self._read_json()
        body = body if isinstance(body, dict) else {}
        st = self._radio_settings(conn)
        dev = radio.check_device(body.get("device")) or st.get("defaultDevice")
        self._send_json(200, self.server.radio.call(st.get("baseUrl"), "/stop", {"device": dev}))

    def _radio_volume(self, conn, query) -> None:
        self._user(conn)
        body = self._read_json()
        body = body if isinstance(body, dict) else {}
        step = body.get("step")
        if step not in ("up", "down"):
            raise ApiError(400, "VALIDATION_ERROR", "step 은 up 또는 down 이에요.")
        st = self._radio_settings(conn)
        dev = radio.check_device(body.get("device")) or st.get("defaultDevice")
        self._send_json(200, self.server.radio.call(st.get("baseUrl"), "/volume", {"device": dev, "step": step}))

    # ───── v2: TV 기기 ─────
    def _pairing_create(self, conn, query) -> None:
        p = self._user(conn)
        res = bs.create_pairing_code(conn, p["actor"])
        audit(conn, p["actor"], "pairing_code")
        self._send_json(200, res)

    def _pair(self, conn, query) -> None:
        ip = self.client_address[0]
        wait = self.server.pair_limiter.retry_after(ip, "pair")
        if wait > 0:
            raise ApiError(429, "RATE_LIMITED", "시도가 너무 많아요. 잠시 뒤 다시 해 주세요.", {"retryAfterSec": wait},
                           headers=[("Retry-After", str(wait))])
        body = self._read_json()
        if not isinstance(body, dict):
            raise ApiError(400, "VALIDATION_ERROR", "코드를 보내 주세요.")
        try:
            token, dev = bs.exchange_pairing_code(conn, body.get("code"), body.get("label") or "")
        except bs.StoreError:
            self.server.pair_limiter.record_failure(ip, "pair")
            raise
        audit(conn, f"device:{dev['id']}", "device_paired", dev["label"])
        self._send_json(200, dev, [self._device_cookie_header(token, bs.DEVICE_COOKIE_MAX_AGE)])

    def _devices_list(self, conn, query) -> None:
        self._user(conn)
        self._send_json(200, {"devices": bs.list_devices(conn)})

    def _device_revoke(self, conn, query, dev_id) -> None:
        p = self._user(conn)
        bs.revoke_device(conn, dev_id)
        audit(conn, p["actor"], "device_revoked", dev_id)
        self._send_json(200, {"ok": True})

    def _device_me(self, conn, query) -> None:
        dev = bs.device_for_token(conn, self._token(DEVICE_COOKIE_NAME))
        if dev is None:
            hs = [self._device_cookie_header("", 0)] if self._token(DEVICE_COOKIE_NAME) else None
            raise ApiError(401, "UNAUTHENTICATED", "연결된 TV가 아니에요.", headers=hs)
        from display import family_of
        row = conn.execute("SELECT data FROM family_doc WHERE id = 1").fetchone()
        doc = json.loads(row["data"]) if row else None
        self._send_json(200, {"id": dev["id"], "label": dev["label"], "mode": dev["mode"],
                              "familyName": family_of(doc if isinstance(doc, dict) else None)["name"]})

    def _device_unpair(self, conn, query) -> None:
        dev = bs.device_for_token(conn, self._token(DEVICE_COOKIE_NAME))
        if dev is not None:
            conn.execute("UPDATE devices SET revoked_at = ? WHERE id = ?", (now_iso(), dev["id"]))
            audit(conn, f"device:{dev['id']}", "device_unpaired")
        self._send_json(200, {"ok": True}, [self._device_cookie_header("", 0)])

    # ───── v2: 보드·날씨 ─────
    def _board(self, conn, query) -> None:
        p = self._principal(conn, allow_device=True)
        viewer = {"kind": p["kind"], "label": p["device"]["label"] if p["kind"] == "device" else None,
                  "role": p["user"]["role"] if p["kind"] == "user" else None}
        self._send_json(200, board.build(conn, self.server.weather, self.server.adapter, viewer))

    def _weather(self, conn, query) -> None:
        self._principal(conn, allow_device=True)
        b = board.build(conn, self.server.weather, self.server.adapter, {"kind": "weather"})
        self._send_json(200, b["weather"])

    # ───── v2: 공지 ─────
    def _notices_list(self, conn, query) -> None:
        self._user(conn)
        self._send_json(200, {"notices": bs.list_notices(conn, self._q(query, "status"))})

    def _notices_create(self, conn, query) -> None:
        p = self._user(conn)
        res = bs.create_notice(conn, self._read_json(), p["actor"], allow_store_original=p["user"]["role"] == "owner")
        self._send_json(200 if res["duplicate"] else 201, res)

    def _notice_get(self, conn, query, nid) -> None:
        self._user(conn)
        self._send_json(200, bs.get_notice(conn, nid, include_original=self._q(query, "original") == "1"))

    def _notice_put(self, conn, query, nid) -> None:
        p = self._user(conn)
        self._send_json(200, bs.update_notice(conn, nid, self._read_json(), p["actor"]))

    def _notice_delete(self, conn, query, nid) -> None:
        p = self._user(conn)
        bs.delete_notice(conn, nid, p["actor"])
        self._send_json(200, {"ok": True})

    def _notice_confirm(self, conn, query, nid) -> None:
        p = self._user(conn)
        body = self._read_json()
        if not isinstance(body, dict):
            raise ApiError(400, "VALIDATION_ERROR", "baseVersion이 필요해요.")
        self._send_json(200, bs.confirm_notice(conn, nid, body.get("baseVersion"), p["actor"], dismiss=body.get("dismiss") is True))

    def _notice_history(self, conn, query, nid) -> None:
        self._user(conn)
        self._send_json(200, {"history": bs.notice_history(conn, nid)})

    def _notice_analysis(self, conn, query, nid) -> None:
        p = self._user(conn)
        body = self._read_json()
        self._send_json(200, kidsnote.save_analysis(conn, nid, body.get("digest") if isinstance(body, dict) else None, p["actor"]))

    def _notices_pending(self, conn, query) -> None:
        self._user(conn)
        self._send_json(200, {"items": kidsnote.pending_texts(conn)})

    def _notices_import(self, conn, query) -> None:
        p = self._user(conn)
        body = self._read_json()
        if not isinstance(body, dict):
            raise ApiError(400, "VALIDATION_ERROR", "items가 필요해요.")
        res = bs.import_notices(conn, body.get("items"), p["actor"], preview=body.get("preview") is not False,
                                allow_store_original=p["user"]["role"] == "owner")
        if not res["preview"]:
            audit(conn, p["actor"], "notices_import", json.dumps(res["summary"]))
        self._send_json(200, res)

    # ───── v2: 준비물·등하원·픽업·공지 일정 ─────
    def _prep_list(self, conn, query) -> None:
        self._user(conn)
        start, end = self._range(query, 7)
        self._send_json(200, {"items": bs.list_prep(conn, start, end)})

    def _prep_add(self, conn, query) -> None:
        p = self._user(conn)
        self._send_json(201, bs.add_prep(conn, self._read_json(), p["actor"]))

    def _prep_patch(self, conn, query, pid) -> None:
        p = self._user(conn)
        self._send_json(200, bs.update_prep(conn, pid, self._read_json(), p["actor"]))

    def _commute_get(self, conn, query) -> None:
        self._user(conn)
        start, end = self._range(query, 13)
        settings = bs.get_settings(conn)
        exc = bs.list_exceptions(conn, start, end)
        row = conn.execute("SELECT data FROM family_doc WHERE id = 1").fetchone()
        doc = json.loads(row["data"]) if row else None
        from display import children_of
        kids = children_of(doc if isinstance(doc, dict) else None)
        days = []
        d = start
        while d <= end:
            days.append({"date": d, "plans": [p for p in (bs.commute_day(settings, exc, c["id"], d) for c in kids) if p]})
            d = bs.add_days(d, 1)
        self._send_json(200, {"settings": settings["commute"], "version": settings["_versions"]["commute"], "exceptions": exc, "days": days})

    def _exception_add(self, conn, query) -> None:
        p = self._user(conn)
        self._send_json(201, bs.add_exception(conn, self._read_json(), p["actor"]))

    def _exception_delete(self, conn, query, eid) -> None:
        self._user(conn)
        bs.delete_exception(conn, eid)
        self._send_json(200, {"ok": True})

    def _pickups_get(self, conn, query) -> None:
        self._user(conn)
        start, end = self._range(query, 6)
        row = conn.execute("SELECT data FROM family_doc WHERE id = 1").fetchone()
        doc = json.loads(row["data"]) if row else None
        from display import adults_of, children_of
        kids = [c["id"] for c in children_of(doc if isinstance(doc, dict) else None)]
        self._send_json(200, {"pickups": bs.pickups_for(conn, bs.get_settings(conn), kids, start, end),
                              "adults": adults_of(doc if isinstance(doc, dict) else None)})

    def _pickups_put(self, conn, query) -> None:
        p = self._user(conn)
        bs.set_pickup(conn, self._read_json(), p["actor"])
        self._send_json(200, {"ok": True})

    def _notice_events_list(self, conn, query) -> None:
        self._user(conn)
        nid = self._q(query, "noticeId")
        if nid:
            self._send_json(200, {"events": bs.notice_events_of(conn, nid)})
            return
        start, end = self._range(query, 30)
        self._send_json(200, {"events": bs.list_notice_events(conn, start, end)})

    def _notice_event_link(self, conn, query, ev_id) -> None:
        self._user(conn)
        bs.link_notice_event(conn, ev_id, self._read_json())
        self._send_json(200, {"ok": True})

    # ───── v2: 키즈노트(공지 자동 수집) ─────
    def _kidsnote_status(self, conn, query) -> None:
        self._user(conn)
        self._send_json(200, kidsnote.status(conn, self.server.adapter))

    def _kidsnote_sync(self, conn, query) -> None:
        p = self._user(conn)
        res = kidsnote.run_sync(conn, self.server.adapter, self.server.analyzer, "manual")
        audit(conn, p["actor"], "notice_sync", "ok" if res.get("ok") else "fail")
        self._send_json(200, res)

    def _kidsnote_resume(self, conn, query) -> None:
        p = self._user(conn)
        kidsnote.resume(conn)
        audit(conn, p["actor"], "notice_sync_resume")
        self._send_json(200, kidsnote.status(conn, self.server.adapter))

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
            "v2": {t: [dict(r) for r in conn.execute(f'SELECT * FROM "{t}"')] for t in V2_BACKUP_TABLES},
        }
        for r in doc["v2"]["notices"]:
            r["original_text"] = None
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
        v2 = body.get("v2")
        if v2 is not None and (not isinstance(v2, dict) or any(not isinstance(v2[t], list) for t in V2_BACKUP_TABLES if t in v2)):
            raise ApiError(400, "VALIDATION_ERROR", "백업 파일의 v2 형식이 올바르지 않아요.")
        if isinstance(v2, dict):
            # v2 표는 doc_backups 에 들어가지 않으므로 복원 직전 DB 파일 전체를 남긴다
            migrations.backup_db(self.server.config.db_path,
                                 self.server.config.db_path.parent / "backups" / f"pre-restore-{re.sub(r'[^0-9]', '', stamp)[:14]}.sqlite3")
            migrations.prune_backups(self.server.config.db_path.parent / "backups", "pre-restore-", keep=10)
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
            if isinstance(v2, dict):  # v2 표도 백업 시점으로 되돌린다(같은 트랜잭션)
                for t in V2_BACKUP_TABLES:
                    if t not in v2:  # 백업 파일에 없는 표는 건드리지 않는다
                        continue
                    cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{t}")')]
                    conn.execute(f'DELETE FROM "{t}"')
                    for row in v2.get(t, []):
                        if not isinstance(row, dict):
                            raise ApiError(400, "VALIDATION_ERROR", "백업 파일의 v2 행 형식이 올바르지 않아요.")
                        if t == "notices":  # 요약은 다시 검증해 넣는다(깨진 백업으로 화면이 멈추지 않게)
                            try:
                                row = {**row, "digest": json.dumps(bs.clean_digest(json.loads(row.get("digest") or "null")), ensure_ascii=False), "original_text": None}
                            except (bs.StoreError, ValueError, TypeError):
                                raise ApiError(400, "VALIDATION_ERROR", "백업 파일의 공지 요약이 올바르지 않아요.")
                        keys = [k for k in row if k in cols]
                        conn.execute(f'INSERT INTO "{t}"({",".join(keys)}) VALUES({",".join("?" * len(keys))})', [row[k] for k in keys])
            audit(conn, u["login_id"], "restore", f"v{cur['version']}->v{version}")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        self._send_json(200, {"version": version, "updatedAt": stamp, "v2Restored": isinstance(v2, dict)})

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


_ID = r"([A-Za-z0-9_-]{1,64})"
ROUTES: List[Tuple[str, "re.Pattern[str]", str]] = [
    (m, re.compile(p), name) for m, p, name in [
        ("GET", r"/api/health", "_health"),
        ("POST", r"/api/login", "_login"),
        ("POST", r"/api/logout", "_logout"),
        ("GET", r"/api/me", "_me"),
        ("GET", r"/api/state", "_state_get"),
        ("PUT", r"/api/state", "_state_put"),
        ("GET", r"/api/backup", "_backup"),
        ("POST", r"/api/restore", "_restore"),
        ("GET", r"/api/settings", "_settings_get"),
        ("PUT", r"/api/settings/(location|commute|screen|notices|kidsnote|tvPrivacy|privacy|radio)", "_settings_put"),
        ("PUT", r"/api/weather-key", "_weather_key_put"),
        ("PUT", r"/api/radio-key", "_radio_key_put"),
        ("DELETE", r"/api/radio-key", "_radio_key_delete"),
        ("GET", r"/api/radio/stations", "_radio_stations"),
        ("GET", r"/api/radio/devices", "_radio_devices"),
        ("GET", r"/api/radio/status", "_radio_status"),
        ("GET", r"/api/radio/stream", "_radio_stream"),
        ("POST", r"/api/radio/play", "_radio_play"),
        ("POST", r"/api/radio/stop", "_radio_stop"),
        ("POST", r"/api/radio/volume", "_radio_volume"),
        ("DELETE", r"/api/weather-key", "_weather_key_delete"),
        ("POST", r"/api/devices/pairing-codes", "_pairing_create"),
        ("POST", r"/api/devices/pair", "_pair"),
        ("GET", r"/api/devices", "_devices_list"),
        ("DELETE", r"/api/devices/" + _ID, "_device_revoke"),
        ("GET", r"/api/device/me", "_device_me"),
        ("POST", r"/api/device/unpair", "_device_unpair"),
        ("GET", r"/api/board", "_board"),
        ("GET", r"/api/weather", "_weather"),
        ("GET", r"/api/notices", "_notices_list"),
        ("POST", r"/api/notices", "_notices_create"),
        ("POST", r"/api/notices/import", "_notices_import"),
        ("GET", r"/api/notices/pending-analysis", "_notices_pending"),
        ("GET", r"/api/notices/" + _ID, "_notice_get"),
        ("PUT", r"/api/notices/" + _ID, "_notice_put"),
        ("DELETE", r"/api/notices/" + _ID, "_notice_delete"),
        ("POST", r"/api/notices/" + _ID + r"/confirm", "_notice_confirm"),
        ("GET", r"/api/notices/" + _ID + r"/history", "_notice_history"),
        ("POST", r"/api/notices/" + _ID + r"/analysis", "_notice_analysis"),
        ("GET", r"/api/preparations", "_prep_list"),
        ("POST", r"/api/preparations", "_prep_add"),
        ("PATCH", r"/api/preparations/" + _ID, "_prep_patch"),
        ("GET", r"/api/commute", "_commute_get"),
        ("POST", r"/api/commute/exceptions", "_exception_add"),
        ("DELETE", r"/api/commute/exceptions/" + _ID, "_exception_delete"),
        ("GET", r"/api/pickups", "_pickups_get"),
        ("PUT", r"/api/pickups", "_pickups_put"),
        ("GET", r"/api/notice-events", "_notice_events_list"),
        ("PUT", r"/api/notice-events/" + _ID + r"/link", "_notice_event_link"),
        ("GET", r"/api/kidsnote/status", "_kidsnote_status"),
        ("POST", r"/api/kidsnote/sync", "_kidsnote_sync"),
        ("POST", r"/api/kidsnote/resume", "_kidsnote_resume"),
    ]
]


class WeatherRefresher(threading.Thread):
    """설정된 위치의 날씨를 10분마다 미리 받아 둔다(화면 요청은 캐시만 읽는다)."""

    def __init__(self, server: "FamilyServer", interval: float = 600.0):
        super().__init__(name="weather-refresh", daemon=True)
        self.server, self.interval = server, interval
        self.stop_event = threading.Event()

    def run(self) -> None:  # pragma: no cover - 스레드 루프
        while True:
            try:
                conn = connect(self.server.config.db_path)
                try:
                    loc = bs.get_settings(conn)["location"]
                    if loc:
                        nx, ny = latlon_to_grid(loc["lat"], loc["lon"])
                        self.server.weather.refresh(conn, nx, ny)
                finally:
                    conn.close()
            except Exception as e:
                print(f"[weather] {type(e).__name__}", file=sys.stderr, flush=True)
            if self.stop_event.wait(self.interval):
                return


# ───────────────────────── 실행 ─────────────────────────


def make_server(config: Config, host: str = "127.0.0.1", port: int = 0) -> FamilyServer:
    init_db(config.db_path, lambda s: print(s, flush=True))
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
    ap.add_argument("--migrate-dry-run", action="store_true", help="DB 사본에 마이그레이션을 시험 적용하고 결과만 보여 준다(운영 DB 변경 없음)")
    ap.add_argument("--restore-db", metavar="BACKUP", help="서버를 끈 상태에서 백업 파일로 DB를 되돌린다")
    ap.add_argument("--set-weather-key", action="store_true", help="기상청(공공데이터포털) 서비스 키를 저장한다(getpass로 입력)")
    ap.add_argument("--notice-source", default=os.environ.get("MGFB_NOTICE_SOURCE"),
                    help="개발·QA 전용: mock:<JSON 파일> 이면 모의 공지 수집을 쓴다")
    args = ap.parse_args(argv)
    db_path = Path(args.db).expanduser()
    if args.init_admin:
        return _prompt_user(args.init_admin, "owner", db_path)
    if args.add_user:
        return _prompt_user(args.add_user, "adult", db_path)
    if args.migrate_dry_run:
        if not db_path.is_file():
            print(f"DB가 없어요: {db_path}", file=sys.stderr)
            return 1
        try:
            for line in migrations.dry_run(db_path, connect):
                print(line)
        except migrations.MigrationError as e:
            print(f"시험 실패: {e}", file=sys.stderr)
            return 1
        return 0
    if args.restore_db:
        migrations.restore_backup(Path(args.restore_db).expanduser(), db_path)
        print(f"DB를 되돌렸어요: {db_path} (이전 DB는 같은 폴더에 .before-restore-* 로 남겼어요)")
        return 0
    if args.set_weather_key:
        key = getpass.getpass("기상청 단기예보 서비스 키(Decoding 키): ").strip()
        if not key:
            print("키가 비어 있어요.", file=sys.stderr)
            return 1
        path = save_key(db_path.parent, key)
        print(f"저장했어요: {path}")
        return 0

    config = Config(db_path=db_path, dist_dir=Path(args.dist).expanduser(), notice_source=args.notice_source)
    try:
        server = make_server(config, args.host, args.port)
    except migrations.MigrationError as e:
        print(f"DB 업그레이드 실패: {e}", file=sys.stderr)
        if e.backup:
            print(f"되돌리려면: python tablet_server/app.py --restore-db \"{e.backup}\"", file=sys.stderr)
        return 1
    server.weather.background = True
    WeatherRefresher(server).start()
    if server.adapter.mode == "mock":
        print(f"[주의] 모의 공지 수집 사용 중: {args.notice_source}")
    kidsnote.SyncScheduler(db_path, connect, server.adapter, server.analyzer).start()
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
