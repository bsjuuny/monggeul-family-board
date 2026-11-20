"""기상청 단기예보(공공데이터포털) 연동 + 서버 캐시 + 옷차림·우산 안내.

- 외부 호출은 서버에서만 한다(브라우저 CSP는 connect-src 'self').
- 서비스 키는 환경변수 MGFB_KMA_KEY 또는 데이터 폴더의 kma_key.txt 에서만 읽고, 로그·응답에 싣지 않는다.
- 실패하면 마지막 정상 캐시를 stale=true 로 돌려준다. 실패 뒤 5분 안에는 다시 부르지 않는다.
- 예보가 없으면 옷차림·우산 안내를 만들지 않는다(추측 금지).
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

KST = timezone(timedelta(hours=9))
BASE_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0"
FCST_BASE_HOURS = (2, 5, 8, 11, 14, 17, 20, 23)
FAIL_BACKOFF_SEC = 5 * 60
STALE_AFTER_MIN = {"ncst": 90, "fcst": 6 * 60}

Fetcher = Callable[[str, Dict[str, str]], Dict[str, Any]]


class WeatherError(RuntimeError):
    pass


# ───── 격자 변환 (기상청 LCC DFS) ─────
def latlon_to_grid(lat: float, lon: float) -> Tuple[int, int]:
    RE, GRID, SLAT1, SLAT2, OLON, OLAT, XO, YO = 6371.00877, 5.0, 30.0, 60.0, 126.0, 38.0, 43, 136
    DEGRAD = math.pi / 180.0
    re = RE / GRID
    slat1, slat2, olon, olat = SLAT1 * DEGRAD, SLAT2 * DEGRAD, OLON * DEGRAD, OLAT * DEGRAD
    sn = math.log(math.cos(slat1) / math.cos(slat2)) / math.log(math.tan(math.pi * 0.25 + slat2 * 0.5) / math.tan(math.pi * 0.25 + slat1 * 0.5))
    sf = math.pow(math.tan(math.pi * 0.25 + slat1 * 0.5), sn) * math.cos(slat1) / sn
    ro = re * sf / math.pow(math.tan(math.pi * 0.25 + olat * 0.5), sn)
    ra = re * sf / math.pow(math.tan(math.pi * 0.25 + lat * DEGRAD * 0.5), sn)
    theta = lon * DEGRAD - olon
    if theta > math.pi:
        theta -= 2.0 * math.pi
    if theta < -math.pi:
        theta += 2.0 * math.pi
    theta *= sn
    return int(math.floor(ra * math.sin(theta) + XO + 0.5)), int(math.floor(ro - ra * math.cos(theta) + YO + 0.5))


# ───── 발표 시각 ─────
def ncst_base(now: datetime) -> Tuple[str, str]:
    """초단기실황: 매시 정각 자료가 약 40분 뒤에 나온다."""
    t = now.astimezone(KST) - timedelta(minutes=40)
    return t.strftime("%Y%m%d"), t.strftime("%H00")


def fcst_base(now: datetime) -> Tuple[str, str]:
    """단기예보: 02·05·08·11·14·17·20·23시 발표, 약 10분 뒤 제공."""
    t = now.astimezone(KST) - timedelta(minutes=10)
    hours = [h for h in FCST_BASE_HOURS if h <= t.hour]
    if not hours:
        t = t - timedelta(days=1)
        return t.strftime("%Y%m%d"), "2300"
    return t.strftime("%Y%m%d"), f"{hours[-1]:02d}00"


# ───── 키 ─────
def load_key(data_dir: Path) -> Optional[str]:
    k = os.environ.get("MGFB_KMA_KEY", "").strip()
    if k:
        return k
    f = data_dir / "kma_key.txt"
    if f.is_file():
        k = f.read_text(encoding="utf-8").strip()
        return k or None
    return None


def save_key(data_dir: Path, key: str) -> Path:
    data_dir.mkdir(parents=True, exist_ok=True)
    f = data_dir / "kma_key.txt"
    f.write_text(key.strip(), encoding="utf-8")
    try:
        os.chmod(f, 0o600)
    except OSError:
        pass
    return f


def http_fetcher(key: str, timeout: float = 8.0) -> Fetcher:
    def fetch(op: str, params: Dict[str, str]) -> Dict[str, Any]:
        q = {"serviceKey": key, "pageNo": "1", "numOfRows": "1000", "dataType": "JSON", **params}
        url = f"{BASE_URL}/{op}?{urllib.parse.urlencode(q)}"
        req = urllib.request.Request(url, headers={"User-Agent": "MonggeulBoard/2.0"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
        except Exception as e:  # 키가 담긴 URL은 오류 메시지에 넣지 않는다
            raise WeatherError(f"기상청 연결 실패({type(e).__name__})") from None
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            text = raw[:400].decode("utf-8", "replace")
            if "SERVICE_KEY" in text or "SERVICE KEY" in text:
                raise WeatherError("기상청 서비스 키가 등록되지 않았거나 이 API 활용 신청이 안 되어 있어요.") from None
            raise WeatherError("기상청 응답 형식이 올바르지 않아요.") from None
        return data

    return fetch


def _items(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    resp = (data or {}).get("response") or {}
    head = resp.get("header") or {}
    if head.get("resultCode") != "00":
        raise WeatherError(f"기상청 오류: {head.get('resultCode')} {head.get('resultMsg', '')}".strip())
    items = (((resp.get("body") or {}).get("items") or {}).get("item")) or []
    if not isinstance(items, list):
        raise WeatherError("기상청 응답에 자료가 없어요.")
    return items


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f <= -900 or f >= 900 else f


PTY = {"0": "none", "1": "rain", "2": "rain_snow", "3": "snow", "4": "shower", "5": "drizzle", "6": "drizzle_snow", "7": "snow_flurry"}
SKY = {"1": "clear", "3": "cloudy", "4": "overcast"}


def condition_ko(sky: Optional[str], pty: Optional[str]) -> str:
    if pty and pty != "none":
        return {"rain": "비", "rain_snow": "비나 눈", "snow": "눈", "shower": "소나기", "drizzle": "이슬비",
                "drizzle_snow": "진눈깨비", "snow_flurry": "눈날림"}.get(pty, "비")
    return {"clear": "맑음", "cloudy": "구름 많음", "overcast": "흐림"}.get(sky or "", "알 수 없음")


def parse_fcst(items: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """{'YYYY-MM-DDTHH:00': {tmp, pop, pty, sky, wsd, reh}} 와 {'date': {tmn, tmx}}"""
    hours: Dict[str, Dict[str, Any]] = {}
    days: Dict[str, Dict[str, Any]] = {}
    for it in items:
        d, t, cat, v = it.get("fcstDate"), it.get("fcstTime"), it.get("category"), it.get("fcstValue")
        if not (isinstance(d, str) and isinstance(t, str) and len(d) == 8 and len(t) == 4):
            continue
        iso_d = f"{d[:4]}-{d[4:6]}-{d[6:]}"
        if cat in ("TMN", "TMX"):
            days.setdefault(iso_d, {})[cat.lower()] = _num(v)
            continue
        h = hours.setdefault(f"{iso_d}T{t[:2]}:00", {})
        if cat == "TMP":
            h["tmp"] = _num(v)
        elif cat == "POP":
            h["pop"] = _num(v)
        elif cat == "PTY":
            h["pty"] = PTY.get(str(v), "none")
        elif cat == "SKY":
            h["sky"] = SKY.get(str(v), "cloudy")
        elif cat == "WSD":
            h["wsd"] = _num(v)
        elif cat == "REH":
            h["reh"] = _num(v)
    return {"hours": hours, "days": days}


def parse_ncst(items: List[Dict[str, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for it in items:
        cat, v = it.get("category"), it.get("obsrValue")
        if cat == "T1H":
            out["tmp"] = _num(v)
        elif cat == "PTY":
            out["pty"] = PTY.get(str(v), "none")
        elif cat == "WSD":
            out["wsd"] = _num(v)
        elif cat == "REH":
            out["reh"] = _num(v)
        elif cat == "RN1":
            out["rn1"] = it.get("obsrValue")
    return out


# ───── 옷차림·우산 안내 ─────
def feels_like(t: Optional[float], wind: Optional[float]) -> Optional[float]:
    if t is None:
        return None
    if wind is not None and t <= 10 and wind > 1.3:
        v = (wind * 3.6) ** 0.16
        return round(13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v, 1)
    return t


def advice(drop: Optional[Dict[str, Any]], pick: Optional[Dict[str, Any]]) -> List[Dict[str, str]]:
    """등원·하원 시점 예보로 짧은 안내를 최대 3개 만든다. 예보가 없으면 빈 목록."""
    pts = [p for p in (drop, pick) if p and p.get("tmp") is not None]
    if not pts:
        return []
    out: List[Dict[str, str]] = []
    coldest = min(feels_like(p.get("tmp"), p.get("wsd")) for p in pts)  # type: ignore[type-var]
    hottest = max(p["tmp"] for p in pts)
    if coldest <= 5:
        out.append({"code": "heavy_coat", "text": "두꺼운 옷 필요", "tone": "cold"})
    elif coldest <= 12:
        out.append({"code": "jacket", "text": "겉옷 챙기기", "tone": "cool"})
    elif coldest <= 17:
        out.append({"code": "light_jacket", "text": "얇은 겉옷", "tone": "mild"})
    else:
        out.append({"code": "light", "text": "가벼운 옷", "tone": "warm"})
    rainy = [p for p in pts if p.get("pty") not in (None, "none") or (p.get("pop") or 0) >= 60]
    pops = [p.get("pop") for p in pts if p.get("pop") is not None]
    if any(p.get("pty") in ("snow", "rain_snow", "snow_flurry", "drizzle_snow") for p in pts):
        out.append({"code": "snow", "text": "눈 와요, 우산·장화", "tone": "rain"})
    elif rainy:
        out.append({"code": "umbrella", "text": "우산 필요" if rainy[0] is drop or len(rainy) == 2 else "하원 때 우산", "tone": "rain"})
    elif pops and max(pops) >= 40:
        out.append({"code": "small_umbrella", "text": "작은 우산 챙기기", "tone": "rain"})
    elif pops:
        out.append({"code": "no_umbrella", "text": "우산 필요 없음", "tone": "dry"})
    winds = [p.get("wsd") for p in pts if p.get("wsd") is not None]
    if coldest <= -5:
        out.append({"code": "cold_alert", "text": "추위 조심", "tone": "cold"})
    elif winds and max(winds) >= 9:
        out.append({"code": "wind", "text": "바람이 강해요", "tone": "wind"})
    elif hottest >= 30:
        out.append({"code": "heat", "text": "더위 조심", "tone": "hot"})
    return out[:3]


# ───── 서비스 ─────
class WeatherService:
    def __init__(self, data_dir: Path, fetcher_factory: Callable[[str], Fetcher] = http_fetcher,
                 clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)):
        self.data_dir = data_dir
        self.fetcher_factory = fetcher_factory
        self.clock = clock
        self._lock = threading.Lock()
        self._last_fail: Dict[str, float] = {}
        self._last_error: Dict[str, str] = {}
        self.background = False

    def key_configured(self) -> bool:
        return load_key(self.data_dir) is not None

    def _cached(self, conn: sqlite3.Connection, kind: str, grid: str) -> Optional[sqlite3.Row]:
        return conn.execute("SELECT * FROM weather_cache WHERE kind = ? AND grid = ?", (kind, grid)).fetchone()

    def refresh(self, conn: sqlite3.Connection, nx: int, ny: int, force: bool = False) -> None:
        """필요한 자료만 새로 받는다. 실패는 기록만 하고 예외를 올리지 않는다."""
        key = load_key(self.data_dir)
        if not key:
            return
        grid = f"{nx},{ny}"
        now = self.clock()
        with self._lock:
            for kind, (bd, bt), op in (("ncst", ncst_base(now), "getUltraSrtNcst"), ("fcst", fcst_base(now), "getVilageFcst")):
                base = bd + bt
                row = self._cached(conn, kind, grid)
                if row is not None and row["base"] == base and not force:
                    continue
                fk = f"{kind}:{grid}"
                if not force and time.monotonic() - self._last_fail.get(fk, -1e9) < FAIL_BACKOFF_SEC:
                    continue
                try:
                    data = self.fetcher_factory(key)(op, {"base_date": bd, "base_time": bt, "nx": str(nx), "ny": str(ny)})
                    items = _items(data)
                    payload = parse_ncst(items) if kind == "ncst" else parse_fcst(items)
                    if kind == "fcst" and not payload["hours"]:
                        raise WeatherError("예보 자료가 비어 있어요.")
                    if kind == "fcst" and row is not None:
                        # 새 발표는 발표 다음 시각부터만 있다. 오늘 앞 시각(예: 08:10 발표 뒤 08시 등원)은 이전 예보로 채운다.
                        old = json.loads(row["payload"])
                        keep_from = now.astimezone(KST).strftime("%Y-%m-%dT00:00")
                        merged = {k: v for k, v in old.get("hours", {}).items() if k >= keep_from}
                        merged.update(payload["hours"])
                        payload["hours"] = merged
                        days = {d: dict(v) for d, v in old.get("days", {}).items()}
                        for d, v in payload["days"].items():
                            days.setdefault(d, {}).update({k: x for k, x in v.items() if x is not None})
                        payload["days"] = days
                    conn.execute(
                        "INSERT INTO weather_cache(kind, grid, base, fetched_at, payload) VALUES(?,?,?,?,?) "
                        "ON CONFLICT(kind, grid) DO UPDATE SET base=excluded.base, fetched_at=excluded.fetched_at, payload=excluded.payload",
                        (kind, grid, base, int(now.timestamp()), json.dumps(payload, ensure_ascii=False)),
                    )
                    self._last_fail.pop(fk, None)
                    self._last_error.pop(fk, None)
                except WeatherError as e:
                    self._last_fail[fk] = time.monotonic()
                    self._last_error[fk] = str(e)

    def snapshot(self, conn: sqlite3.Connection, location: Optional[Dict[str, Any]], today: str,
                 dropoff_at: Optional[str], pickup_at: Optional[str], tomorrow_dropoff_at: Optional[str],
                 tomorrow_pickup_at: Optional[str] = None) -> Dict[str, Any]:
        if not location:
            return {"configured": False, "reason": "location"}
        if not self.key_configured():
            return {"configured": False, "reason": "key", "location": location.get("name")}
        nx, ny = latlon_to_grid(location["lat"], location["lon"])
        grid = f"{nx},{ny}"
        # 백그라운드 갱신 스레드가 있으면 화면 요청은 캐시만 읽는다(처음 한 번만 직접 받는다).
        if not self.background or self._cached(conn, "fcst", grid) is None:
            self.refresh(conn, nx, ny)
        now = self.clock()
        n_row, f_row = self._cached(conn, "ncst", grid), self._cached(conn, "fcst", grid)
        if f_row is None and n_row is None:
            err = self._last_error.get(f"fcst:{grid}") or self._last_error.get(f"ncst:{grid}")
            return {"configured": True, "available": False, "location": location.get("name"), "error": err or "아직 날씨를 받지 못했어요."}
        fc = json.loads(f_row["payload"]) if f_row else {"hours": {}, "days": {}}
        nc = json.loads(n_row["payload"]) if n_row else {}
        hours = fc["hours"]
        cur_key = now.astimezone(KST).strftime("%Y-%m-%dT%H:00")

        def at(d: str, hhmm: Optional[str]) -> Optional[Dict[str, Any]]:
            if not hhmm:
                return None
            k = f"{d}T{hhmm[:2]}:00"
            h = hours.get(k)
            if not h:
                return None
            return {"time": hhmm, **h, "condition": condition_ko(h.get("sky"), h.get("pty"))}

        def day(d: str) -> Dict[str, Any]:
            vals = [v["tmp"] for k, v in hours.items() if k.startswith(d) and v.get("tmp") is not None]
            pops = [v["pop"] for k, v in hours.items() if k.startswith(d) and v.get("pop") is not None]
            dd = fc["days"].get(d, {})
            noon = hours.get(f"{d}T12:00") or hours.get(f"{d}T09:00") or {}
            return {"min": dd.get("tmn") if dd.get("tmn") is not None else (min(vals) if vals else None),
                    "max": dd.get("tmx") if dd.get("tmx") is not None else (max(vals) if vals else None),
                    "popMax": max(pops) if pops else None, "condition": condition_ko(noon.get("sky"), noon.get("pty")) if noon else None}

        cur_h = hours.get(cur_key) or next((hours[k] for k in sorted(hours) if k >= cur_key), None) or (hours[max(hours)] if hours else {})
        current = {
            "temp": nc.get("tmp") if nc.get("tmp") is not None else cur_h.get("tmp"),
            "pty": nc.get("pty") or cur_h.get("pty") or "none",
            "sky": cur_h.get("sky"),
            "wind": nc.get("wsd") if nc.get("wsd") is not None else cur_h.get("wsd"),
            "humidity": nc.get("reh"),
            "pop": cur_h.get("pop"),
        }
        current["condition"] = condition_ko(current["sky"], current["pty"])
        tomorrow = (datetime.fromisoformat(today) + timedelta(days=1)).date().isoformat()
        drop, pick = at(today, dropoff_at), at(today, pickup_at)
        t_drop = at(tomorrow, tomorrow_dropoff_at)
        ages = {k: int((now.timestamp() - r["fetched_at"]) / 60) for k, r in (("ncst", n_row), ("fcst", f_row)) if r is not None}
        stale = f_row is None or any(age > STALE_AFTER_MIN[k] for k, age in ages.items())
        # 기준 시각은 등하원 예보·추천의 근거인 단기예보 기준(없으면 실황)
        fetched = (f_row or n_row)["fetched_at"]
        upcoming = sorted(k for k in hours if k >= cur_key)[:12]
        return {
            "configured": True, "available": True, "location": location.get("name"),
            "current": current, "today": day(today), "tomorrow": {**day(tomorrow), "dropoff": t_drop},
            "dropoff": drop, "pickup": pick,
            "advice": advice(drop, pick), "tomorrowAdvice": advice(t_drop, at(tomorrow, tomorrow_pickup_at or pickup_at)),
            "hourly": [{"at": k, **hours[k], "condition": condition_ko(hours[k].get("sky"), hours[k].get("pty"))} for k in upcoming],
            "updatedAt": datetime.fromtimestamp(fetched, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "stale": stale, "ageMinutes": ages.get("fcst", ages.get("ncst")),
            "error": (self._last_error.get(f"fcst:{grid}") or self._last_error.get(f"ncst:{grid}")) if stale else None,
            "source": "기상청 단기예보",
        }
