"""미니PC의 radio-cast 서버를 패밀리보드가 대신 부른다.

- radio-cast 는 비밀번호(X-Radio-Key)가 필요하고, 다른 웹페이지가 직접 부르는 요청(cross-site)은 막는다.
  그래서 보드 화면이 아니라 이 태블릿 서버가 집 안에서 서버끼리 부른다(radio-cast 보안 설정은 그대로).
- 비밀번호는 기상청 키처럼 태블릿 안 파일(radio_key.txt, 0600)에만 두고 응답·로그에 다시 내보내지 않는다.
- radio-cast 주소는 집 안(사설) IPv4 의 http 주소만 받는다(보드 서버가 아무 곳에나 요청하지 않게).
- 두 가지 듣기: 구글 스피커로 틀기(/play·/stop·/volume·/status) · 태블릿 자체 스피커(/stream 으로 방송 주소만 받기).
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

KEY_FILE = "radio_key.txt"
STATION_RE = re.compile(r"^[a-z0-9_]{2,32}$")
TIMEOUT = 25.0  # radio-cast 는 스피커를 찾고 재생이 시작될 때까지 기다렸다 답한다

Fetcher = Callable[[str, Dict[str, str], float], Tuple[int, Any]]


class RadioError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


# ───── 비밀번호 ─────

def load_key(data_dir: Path) -> Optional[str]:
    k = os.environ.get("MGFB_RADIO_KEY", "").strip()
    if k:
        return k
    f = data_dir / KEY_FILE
    if f.is_file():
        k = f.read_text(encoding="utf-8").strip()
        return k or None
    return None


def key_source(data_dir: Path) -> Optional[str]:
    if os.environ.get("MGFB_RADIO_KEY", "").strip():
        return "env"
    return "file" if (data_dir / KEY_FILE).is_file() else None


def save_key(data_dir: Path, key: str) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    f = data_dir / KEY_FILE
    f.write_text(key.strip(), encoding="utf-8")
    try:
        os.chmod(f, 0o600)
    except OSError:
        pass


def delete_key(data_dir: Path) -> bool:
    f = data_dir / KEY_FILE
    if f.is_file():
        f.unlink()
        return True
    return False


# ───── 주소 ─────

def clean_base_url(v: Any) -> Optional[str]:
    """'http://192.168.0.130:8765' 같은 집 안 주소만. 아니면 None."""
    if not isinstance(v, str) or not v.strip():
        return None
    u = urllib.parse.urlparse(v.strip())
    if u.scheme != "http" or not u.hostname or u.path not in ("", "/") or u.query or u.fragment or u.username or u.password:
        return None
    try:
        ip = ipaddress.ip_address(u.hostname)
    except ValueError:
        return None
    if ip.version != 4 or not (ip.is_private or ip.is_loopback) or ip.is_link_local:
        return None
    port = u.port or 80
    return f"http://{ip}:{port}"


def http_fetcher(url: str, headers: Dict[str, str], timeout: float) -> Tuple[int, Any]:
    req = urllib.request.Request(url, headers={**headers, "Accept": "application/json", "User-Agent": "monggeul-family-board"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - 집 안 주소만(clean_base_url)
            return r.status, json.loads(r.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8") or "null")
        except (ValueError, OSError):
            body = None
        return e.code, body


class RadioClient:
    def __init__(self, data_dir: Path, fetcher: Optional[Fetcher] = None):
        self.data_dir = data_dir
        self.fetch = fetcher or http_fetcher

    def call(self, base_url: Optional[str], path: str, params: Optional[Dict[str, str]] = None, key: Optional[str] = None) -> Any:
        base = clean_base_url(base_url)
        if not base:
            raise RadioError(409, "RADIO_NOT_SET", "설정에서 라디오 서버 주소를 먼저 넣어 주세요.")
        key = key if key is not None else load_key(self.data_dir)
        if not key:
            raise RadioError(409, "RADIO_NO_KEY", "라디오 서버 비밀번호가 아직 없어요. 태블릿에서 설정 → 라디오에 넣어 주세요.")
        q = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v not in (None, "")})
        url = f"{base}{path}" + (f"?{q}" if q else "")
        try:
            status, body = self.fetch(url, {"X-Radio-Key": key}, TIMEOUT)
        except (OSError, ValueError) as e:
            raise RadioError(502, "RADIO_UNREACHABLE", f"라디오 서버(미니PC)에 연결할 수 없어요. 미니PC가 켜져 있는지 확인해 주세요({type(e).__name__}).") from None
        msg = (body or {}).get("error") if isinstance(body, dict) else None
        if status == 401:
            raise RadioError(502, "RADIO_KEY_WRONG", "라디오 서버 비밀번호가 맞지 않아요. 설정 → 라디오에서 다시 넣어 주세요.")
        if status == 429:
            raise RadioError(429, "RADIO_LOCKED", "비밀번호를 여러 번 틀려 라디오 서버가 10분간 잠겼어요.")
        if status == 503:
            raise RadioError(502, "RADIO_SERVER_NO_KEY", "라디오 서버에 비밀번호가 설정되지 않았어요(미니PC radio-cast 설정 확인).")
        if status == 403:
            raise RadioError(502, "RADIO_FORBIDDEN", "라디오 서버가 이 태블릿의 요청을 막았어요(집 안 주소·방화벽 확인).")
        if status >= 400:
            raise RadioError(502 if status >= 500 else 400, "RADIO_ERROR", f"라디오 서버: {msg or f'오류 {status}'}")
        return body


def check_station(v: Any) -> str:
    if not isinstance(v, str) or not STATION_RE.match(v):
        raise RadioError(400, "VALIDATION_ERROR", "채널을 골라 주세요.")
    return v


def check_device(v: Any) -> Optional[str]:
    if v is None or v == "":
        return None
    if not isinstance(v, str) or len(v) > 60 or any(ord(c) < 32 for c in v):
        raise RadioError(400, "VALIDATION_ERROR", "스피커 이름이 올바르지 않아요.")
    return v
