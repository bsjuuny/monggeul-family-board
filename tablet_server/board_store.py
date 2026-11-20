"""v2 데이터 저장소: 설정, TV 기기, 공지(요약)와 파생 항목, 등하원, 픽업.

모든 함수는 호출자가 연 sqlite3 연결을 받는다. 쓰기 함수는 스스로 BEGIN IMMEDIATE/COMMIT 한다.
가족 문서(family_doc)는 읽기만 한다(TV 요약용). 공지 저장은 가족 문서 PUT과 분리되어 있다.
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import sqlite3
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

KST = timezone(timedelta(hours=9))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
PAIRING_TTL = 10 * 60
DEVICE_IDLE_TTL = 180 * 24 * 3600  # 마지막 사용 뒤 180일 지나면 만료
DEVICE_COOKIE_MAX_AGE = 400 * 24 * 3600  # 브라우저 상한
NOTICE_LIST_LIMIT = 300


class StoreError(Exception):
    def __init__(self, status: int, code: str, message: str, extra: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra or {}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def today_kst(now: Optional[datetime] = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(KST).date().isoformat()


def add_days(d: str, n: int) -> str:
    return (date.fromisoformat(d) + timedelta(days=n)).isoformat()


def iso_weekday(d: str) -> int:
    return date.fromisoformat(d).isoweekday()  # 1=월 … 7=일


def _tx(conn: sqlite3.Connection):
    class _T:
        def __enter__(self_inner):
            conn.execute("BEGIN IMMEDIATE")
            return conn

        def __exit__(self_inner, exc_type, exc, tb):
            conn.execute("ROLLBACK" if exc_type else "COMMIT")
            return False

    return _T()


def _s(v: Any, maxlen: int) -> str:
    if not isinstance(v, str):
        return ""
    v = re.sub(r"\s+", " ", v).strip()
    return v[:maxlen]


def _opt_date(v: Any) -> Optional[str]:
    if isinstance(v, str) and DATE_RE.match(v):
        try:
            date.fromisoformat(v)
            return v
        except ValueError:
            return None
    return None


def _opt_time(v: Any) -> Optional[str]:
    return v if isinstance(v, str) and TIME_RE.match(v) else None


# ───────────────────────── 설정 ─────────────────────────

DEFAULT_SETTINGS: Dict[str, Any] = {
    "location": None,
    "commute": {"children": {}},
    "screen": {"morningFrom": "05:00", "afternoonFrom": "11:30", "eveningFrom": "18:00"},
    "notices": {"storeOriginal": False, "autoShowGeneral": True},
    "kidsnote": {"enabled": False, "times": ["07:00", "11:00", "16:00", "20:00"]},
}


def _validate_weekdays(v: Any) -> List[int]:
    if not isinstance(v, list) or not all(isinstance(x, int) and 1 <= x <= 7 for x in v):
        raise StoreError(400, "VALIDATION_ERROR", "요일은 1(월)~7(일) 숫자 목록이어야 해요.")
    return sorted(set(v))


def _validate_time_map(v: Any, what: str) -> Dict[str, str]:
    if v is None:
        return {}
    if not isinstance(v, dict):
        raise StoreError(400, "VALIDATION_ERROR", f"{what} 형식이 올바르지 않아요.")
    out: Dict[str, str] = {}
    for k, t in v.items():
        if k not in {"1", "2", "3", "4", "5", "6", "7"} or not _opt_time(t):
            raise StoreError(400, "VALIDATION_ERROR", f"{what}의 요일·시각을 확인해 주세요.")
        out[k] = t
    return out


def _validate_name_map(v: Any) -> Dict[str, str]:
    if v is None:
        return {}
    if not isinstance(v, dict):
        raise StoreError(400, "VALIDATION_ERROR", "요일별 담당자 형식이 올바르지 않아요.")
    out: Dict[str, str] = {}
    for k, name in v.items():
        if k not in {"1", "2", "3", "4", "5", "6", "7"} or not isinstance(name, str):
            raise StoreError(400, "VALIDATION_ERROR", "요일별 담당자를 확인해 주세요.")
        if name.strip():
            out[k] = _s(name, 20)
    return out


def validate_setting(key: str, value: Any) -> Any:
    if key == "location":
        if value is None:
            return None
        if not isinstance(value, dict):
            raise StoreError(400, "VALIDATION_ERROR", "위치 형식이 올바르지 않아요.")
        lat, lon = value.get("lat"), value.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)) or not (32 <= lat <= 39.5) or not (124 <= lon <= 132):
            raise StoreError(400, "VALIDATION_ERROR", "대한민국 안의 위도·경도를 입력해 주세요.")
        return {"name": _s(value.get("name"), 30) or "우리 동네", "lat": round(float(lat), 4), "lon": round(float(lon), 4)}
    if key == "commute":
        if not isinstance(value, dict) or not isinstance(value.get("children"), dict):
            raise StoreError(400, "VALIDATION_ERROR", "등하원 설정 형식이 올바르지 않아요.")
        out: Dict[str, Any] = {}
        for cid, c in value["children"].items():
            if not isinstance(cid, str) or len(cid) > 64 or not isinstance(c, dict):
                raise StoreError(400, "VALIDATION_ERROR", "아이별 등하원 설정을 확인해 주세요.")
            for f in ("leaveHomeAt", "arriveBy", "pickupAt"):
                if not _opt_time(c.get(f)):
                    raise StoreError(400, "VALIDATION_ERROR", "출발·도착·하원 시각은 HH:MM 이어야 해요.")
            if c["leaveHomeAt"] > c["arriveBy"]:
                raise StoreError(400, "VALIDATION_ERROR", "집 출발 시각은 도착 목표 시각보다 빨라야 해요.")
            out[cid] = {
                "weekdays": _validate_weekdays(c.get("weekdays", [1, 2, 3, 4, 5])),
                "leaveHomeAt": c["leaveHomeAt"],
                "arriveBy": c["arriveBy"],
                "pickupAt": c["pickupAt"],
                "pickupAtByWeekday": _validate_time_map(c.get("pickupAtByWeekday"), "요일별 하원 시각"),
                "pickupAssignee": _s(c.get("pickupAssignee"), 20),
                "pickupAssigneeByWeekday": _validate_name_map(c.get("pickupAssigneeByWeekday")),
            }
        return {"children": out}
    if key == "screen":
        if not isinstance(value, dict):
            raise StoreError(400, "VALIDATION_ERROR", "화면 전환 설정 형식이 올바르지 않아요.")
        m, a, e = value.get("morningFrom"), value.get("afternoonFrom"), value.get("eveningFrom")
        if not (_opt_time(m) and _opt_time(a) and _opt_time(e)) or not (m < a < e):
            raise StoreError(400, "VALIDATION_ERROR", "아침 < 오후 < 저녁 순서의 HH:MM 시각을 넣어 주세요.")
        return {"morningFrom": m, "afternoonFrom": a, "eveningFrom": e}
    if key == "notices":
        if not isinstance(value, dict):
            raise StoreError(400, "VALIDATION_ERROR", "공지 설정 형식이 올바르지 않아요.")
        return {"storeOriginal": bool(value.get("storeOriginal")), "autoShowGeneral": value.get("autoShowGeneral", True) is not False}
    if key == "kidsnote":
        if not isinstance(value, dict):
            raise StoreError(400, "VALIDATION_ERROR", "키즈노트 설정 형식이 올바르지 않아요.")
        times = value.get("times", DEFAULT_SETTINGS["kidsnote"]["times"])
        if not isinstance(times, list) or not (1 <= len(times) <= 6) or not all(_opt_time(t) for t in times):
            raise StoreError(400, "VALIDATION_ERROR", "동기화 시각은 HH:MM 1~6개여야 해요(하루 6회 이하).")
        return {"enabled": bool(value.get("enabled")), "times": sorted(set(times))}
    raise StoreError(404, "NOT_FOUND", "없는 설정이에요.")


def get_settings(conn: sqlite3.Connection) -> Dict[str, Any]:
    out = json.loads(json.dumps(DEFAULT_SETTINGS))
    versions: Dict[str, int] = {k: 0 for k in DEFAULT_SETTINGS}
    for row in conn.execute("SELECT key, value, version FROM settings"):
        if row["key"] in out:
            out[row["key"]] = json.loads(row["value"])
            versions[row["key"]] = row["version"]
    out["_versions"] = versions
    return out


def put_setting(conn: sqlite3.Connection, key: str, value: Any, base_version: Any, actor: str) -> Dict[str, Any]:
    if key not in DEFAULT_SETTINGS:
        raise StoreError(404, "NOT_FOUND", "없는 설정이에요.")
    if not isinstance(base_version, int) or isinstance(base_version, bool) or base_version < 0:
        raise StoreError(400, "VALIDATION_ERROR", "baseVersion이 필요해요.")
    clean = validate_setting(key, value)
    with _tx(conn):
        row = conn.execute("SELECT version FROM settings WHERE key = ?", (key,)).fetchone()
        cur = row["version"] if row else 0
        if cur != base_version:
            raise StoreError(409, "VERSION_CONFLICT", "다른 기기가 먼저 설정을 바꿨어요.", {"version": cur})
        text = json.dumps(clean, ensure_ascii=False, separators=(",", ":"))
        if row:
            conn.execute("UPDATE settings SET value=?, version=version+1, updated_at=?, updated_by=? WHERE key=?",
                         (text, now_iso(), actor, key))
        else:
            conn.execute("INSERT INTO settings(key, value, version, updated_at, updated_by) VALUES(?,?,1,?,?)",
                         (key, text, now_iso(), actor))
    return {"key": key, "value": clean, "version": cur + 1}


# ───────────────────────── TV 기기 ─────────────────────────


def create_pairing_code(conn: sqlite3.Connection, actor: str, now: Optional[int] = None) -> Dict[str, Any]:
    now = now or int(time.time())
    with _tx(conn):
        conn.execute("DELETE FROM pairing_codes WHERE expires_at <= ? OR used_at IS NOT NULL", (now,))
        live = conn.execute("SELECT COUNT(*) FROM pairing_codes").fetchone()[0]
        if live >= 5:
            raise StoreError(429, "RATE_LIMITED", "연결 코드가 너무 많아요. 10분 뒤 다시 만들어 주세요.")
        for _ in range(10):
            code = f"{secrets.randbelow(10**6):06d}"
            try:
                conn.execute("INSERT INTO pairing_codes(code_hash, created_by, created_at, expires_at) VALUES(?,?,?,?)",
                             (sha256("pair:" + code), actor, now, now + PAIRING_TTL))
                break
            except sqlite3.IntegrityError:
                continue
        else:  # pragma: no cover
            raise StoreError(500, "INTERNAL_ERROR", "코드를 만들지 못했어요.")
    exp = datetime.fromtimestamp(now + PAIRING_TTL, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"code": code, "expiresAt": exp}


def exchange_pairing_code(conn: sqlite3.Connection, code: str, label: str, now: Optional[int] = None) -> Tuple[str, Dict[str, Any]]:
    now = now or int(time.time())
    if not isinstance(code, str) or not re.fullmatch(r"\d{6}", code):
        raise StoreError(400, "VALIDATION_ERROR", "6자리 숫자 코드를 입력해 주세요.")
    label = _s(label, 30) or "거실 TV"
    with _tx(conn):
        row = conn.execute("SELECT * FROM pairing_codes WHERE code_hash = ?", (sha256("pair:" + code),)).fetchone()
        if not row or row["used_at"] is not None or row["expires_at"] <= now:
            raise StoreError(400, "PAIRING_INVALID", "코드가 맞지 않거나 시간이 지났어요. 새 코드를 만들어 주세요.")
        conn.execute("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?", (now, row["code_hash"]))
        token = secrets.token_urlsafe(32)
        dev_id = new_id("dev")
        conn.execute(
            "INSERT INTO devices(id, label, mode, token_hash, created_by, created_at, last_seen_at, expires_at) VALUES(?,?,?,?,?,?,?,?)",
            (dev_id, label, "tv", sha256(token), row["created_by"], now_iso(), now, now + DEVICE_IDLE_TTL),
        )
    return token, {"id": dev_id, "label": label, "mode": "tv"}


def device_for_token(conn: sqlite3.Connection, token: Optional[str], now: Optional[int] = None) -> Optional[sqlite3.Row]:
    if not token:
        return None
    now = now or int(time.time())
    row = conn.execute("SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
                       (sha256(token), now)).fetchone()
    if row and (row["last_seen_at"] is None or now - row["last_seen_at"] > 3600):
        # 사용 중인 기기는 만료를 계속 늘린다(시간당 1번만 기록)
        conn.execute("UPDATE devices SET last_seen_at = ?, expires_at = ? WHERE id = ?", (now, now + DEVICE_IDLE_TTL, row["id"]))
    return row


def list_devices(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    out = []
    for r in conn.execute("SELECT * FROM devices ORDER BY created_at DESC"):
        out.append({
            "id": r["id"], "label": r["label"], "mode": r["mode"], "createdAt": r["created_at"],
            "lastSeenAt": datetime.fromtimestamp(r["last_seen_at"], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if r["last_seen_at"] else None,
            "expiresAt": datetime.fromtimestamp(r["expires_at"], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "revokedAt": r["revoked_at"],
        })
    return out


def revoke_device(conn: sqlite3.Connection, dev_id: str) -> None:
    with _tx(conn):
        cur = conn.execute("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", (now_iso(), dev_id))
        if cur.rowcount == 0:
            raise StoreError(404, "NOT_FOUND", "없거나 이미 해제된 기기예요.")


# ───────────────────────── 공지 ─────────────────────────

NOTICE_SOURCES = ("manual", "gongjitalk", "kidsnote", "mock")
PREP_FOR = {"dropoff": "dropoff", "pickup": "pickup", "event": "event", "unspecified": "dropoff"}


def _list_of_str(v: Any, n: int, maxlen: int = 120) -> List[str]:
    if not isinstance(v, list):
        return []
    return [s for s in (_s(x, maxlen) for x in v[:n]) if s]


def clean_digest(d: Any) -> Dict[str, Any]:
    """클라이언트(또는 분석기)가 보낸 공지 요약을 검증·정리한다. 모르는 필드는 버린다."""
    if not isinstance(d, dict):
        raise StoreError(400, "VALIDATION_ERROR", "digest가 필요해요.")
    title = _s(d.get("title"), 80)
    if not title:
        raise StoreError(400, "VALIDATION_ERROR", "공지 제목(요약)이 필요해요.")

    def dated_items(v: Any, n: int, extra: Tuple[str, ...] = ()) -> List[Dict[str, Any]]:
        out = []
        if not isinstance(v, list):
            return out
        for x in v[:n]:
            if not isinstance(x, dict):
                continue
            text = _s(x.get("text"), 120)
            if not text:
                continue
            item: Dict[str, Any] = {"text": text, "date": _opt_date(x.get("date"))}
            if "for" in extra:
                item["for"] = x.get("for") if x.get("for") in PREP_FOR else "unspecified"
            if "deadline" in extra:
                item["date"] = _opt_date(x.get("deadline")) or item["date"]
            out.append(item)
        return out

    dates = []
    if isinstance(d.get("dates"), list):
        for x in d["dates"][:12]:
            if isinstance(x, dict) and _opt_date(x.get("date")):
                dates.append({
                    "date": x["date"], "endDate": _opt_date(x.get("endDate")), "time": _opt_time(x.get("time")),
                    "text": _s(x.get("text"), 60),
                    "kind": x.get("kind") if x.get("kind") in ("event", "deadline", "mention") else "mention",
                    "confidence": x.get("confidence") if x.get("confidence") in ("exact", "relative", "inferred") else "inferred",
                })

    def change(v: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(v, dict):
            return None
        dd = _opt_date(v.get("date"))
        if not dd:
            return None
        return {"date": dd, "endDate": _opt_date(v.get("endDate")), "time": _opt_time(v.get("time")), "text": _s(v.get("text"), 120),
                "early": bool(v.get("early"))}

    conf = d.get("dateConfidence")
    out = {
        "schema": 1,
        "title": title,
        "summary": _s(d.get("summary"), 200),
        "kinds": _list_of_str(d.get("kinds"), 8, 20),
        "eventDate": _opt_date(d.get("eventDate")),
        "eventEndDate": _opt_date(d.get("eventEndDate")),
        "eventTime": _opt_time(d.get("eventTime")),
        "dateConfidence": conf if conf in ("exact", "relative", "inferred", "unknown") else "unknown",
        "dates": dates,
        "supplies": dated_items(d.get("supplies"), 15, ("for",)),
        "clothing": dated_items(d.get("clothing"), 6),
        "documents": dated_items(d.get("documents"), 6, ("deadline",)),
        "parentTasks": dated_items(d.get("parentTasks"), 8, ("deadline",)),
        "fees": _list_of_str(d.get("fees"), 5, 60),
        "dropoffChange": change(d.get("dropoffChange")),
        "pickupChange": change(d.get("pickupChange")),
        "closure": change(d.get("closure")),
        "needsReply": bool(d.get("needsReply")),
        "replyText": _s(d.get("replyText"), 120),
        "needsConfirmation": _list_of_str(d.get("needsConfirmation"), 6, 160),
        "cautions": _list_of_str(d.get("cautions"), 6, 160),
        "confidence": max(0, min(100, int(d.get("confidence") or 0))) if isinstance(d.get("confidence"), (int, float)) else 0,
    }
    return out


IMPORTANT_KINDS = {"서류·동의", "납부·결제"}


def review_reasons(dg: Dict[str, Any]) -> List[str]:
    """보호자 확인이 필요한 이유(비어 있으면 일반 정보)."""
    r: List[str] = []
    if dg["dropoffChange"]:
        r.append("등원 시간 변경")
    if dg["pickupChange"]:
        r.append("조기 하원" if dg["pickupChange"].get("early") else "하원 시간 변경")
    if dg["closure"]:
        r.append("휴원")
    if dg["documents"] or "서류·동의" in dg["kinds"]:
        r.append("제출·동의")
    if dg["fees"] or "납부·결제" in dg["kinds"]:
        r.append("비용 납부")
    if any(x.get("date") for x in dg["parentTasks"]) or any(x["kind"] == "deadline" for x in dg["dates"]):
        r.append("기한")
    has_dated_content = bool(dg["supplies"] or dg["dates"] or dg["eventDate"])
    if has_dated_content and dg["dateConfidence"] in ("unknown", "inferred"):
        r.append("날짜 확인")
    return r


def _derive(dg: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    prep: List[Dict[str, Any]] = []
    for s in dg["supplies"]:
        prep.append({"kind": PREP_FOR[s.get("for", "unspecified")], "date": s["date"] or dg["eventDate"], "text": s["text"], "review": False})
    for c in dg["clothing"]:
        prep.append({"kind": "dropoff", "date": c["date"] or dg["eventDate"], "text": f"복장: {c['text']}", "review": False})
    for x in dg["documents"]:
        prep.append({"kind": "document", "date": x["date"], "text": x["text"], "review": True})
    for x in dg["parentTasks"]:
        prep.append({"kind": "parent_task", "date": x["date"] or dg["eventDate"], "text": x["text"], "review": bool(x["date"])})
    if dg["needsReply"]:
        prep.append({"kind": "parent_task", "date": None, "text": dg["replyText"] or "선생님께 답장하기", "review": False})
    exc: List[Dict[str, Any]] = []
    if dg["dropoffChange"]:
        c = dg["dropoffChange"]
        exc.append({"kind": "dropoff_time", "date": c["date"], "endDate": None, "time": c["time"], "note": c["text"]})
    if dg["pickupChange"]:
        c = dg["pickupChange"]
        exc.append({"kind": "pickup_time", "date": c["date"], "endDate": None, "time": c["time"], "note": c["text"]})
    if dg["closure"]:
        c = dg["closure"]
        exc.append({"kind": "closed", "date": c["date"], "endDate": c["endDate"], "time": None, "note": c["text"]})
    events: List[Dict[str, Any]] = []
    seen = set()
    if dg["eventDate"]:
        events.append({"date": dg["eventDate"], "endDate": dg["eventEndDate"], "time": dg["eventTime"], "title": dg["title"], "kind": "event"})
        seen.add(dg["eventDate"])
    for x in dg["dates"]:
        if x["kind"] == "event" and x["date"] not in seen:
            seen.add(x["date"])
            events.append({"date": x["date"], "endDate": x["endDate"], "time": x["time"], "title": x["text"] or dg["title"], "kind": "event"})
    return {"prep": prep, "exc": exc, "events": events}


def _key(*parts: Any) -> str:
    return sha256("|".join("" if p is None else re.sub(r"\s+", "", str(p)) for p in parts))[:32]


def _apply_derived(conn: sqlite3.Connection, notice_id: str, dg: Dict[str, Any], review: bool) -> None:
    """요약에서 파생 항목을 만든다. 같은 항목은 같은 key라 완료 상태가 유지되고, 사용자가 고친 항목은 건드리지 않는다."""
    d = _derive(dg)
    stamp = now_iso()
    keep_prep, keep_exc, keep_ev = set(), set(), set()
    for p in d["prep"]:
        k = _key(notice_id, "prep", p["kind"], p["date"], p["text"])
        keep_prep.add(k)
        nr = 1 if (review or p["review"]) else 0
        cur = conn.execute("SELECT id, user_edited FROM prep_items WHERE item_key = ?", (k,)).fetchone()
        if cur is None:
            conn.execute("INSERT INTO prep_items(id, item_key, notice_id, date, kind, text, needs_review, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                         (new_id("prep"), k, notice_id, p["date"], p["kind"], p["text"], nr, stamp, stamp))
        elif not cur["user_edited"]:
            conn.execute("UPDATE prep_items SET needs_review=?, deleted_at=NULL, updated_at=? WHERE id=?", (nr, stamp, cur["id"]))
    for e in d["exc"]:
        k = _key(notice_id, "exc", e["kind"], e["date"], e["time"])
        keep_exc.add(k)
        cur = conn.execute("SELECT id, user_edited FROM commute_exceptions WHERE item_key = ?", (k,)).fetchone()
        if cur is None:
            conn.execute("INSERT INTO commute_exceptions(id, item_key, notice_id, date, end_date, kind, time, note, needs_review, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                         (new_id("exc"), k, notice_id, e["date"], e["endDate"], e["kind"], e["time"], e["note"], 1 if review else 0, stamp, stamp))
        elif not cur["user_edited"]:
            conn.execute("UPDATE commute_exceptions SET needs_review=?, end_date=?, note=?, deleted_at=NULL, updated_at=? WHERE id=?",
                         (1 if review else 0, e["endDate"], e["note"], stamp, cur["id"]))
    for ev in d["events"]:
        k = _key(notice_id, "ev", ev["date"])
        keep_ev.add(k)
        cur = conn.execute("SELECT id FROM notice_events WHERE item_key = ?", (k,)).fetchone()
        if cur is None:
            conn.execute("INSERT INTO notice_events(id, item_key, notice_id, date, end_date, time, title, kind, needs_review, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                         (new_id("nev"), k, notice_id, ev["date"], ev["endDate"], ev["time"], ev["title"], ev["kind"], 1 if review else 0, stamp, stamp))
        else:
            conn.execute("UPDATE notice_events SET end_date=?, time=?, title=?, needs_review=?, deleted_at=NULL, updated_at=? WHERE id=?",
                         (ev["endDate"], ev["time"], ev["title"], 1 if review else 0, stamp, cur["id"]))
    # 더 이상 요약에 없는 파생 항목은 감춘다(사용자가 고친 것은 남긴다)
    for table, keep in (("prep_items", keep_prep), ("commute_exceptions", keep_exc)):
        for r in conn.execute(f"SELECT id, item_key, user_edited FROM {table} WHERE notice_id = ? AND deleted_at IS NULL", (notice_id,)).fetchall():
            if r["item_key"] not in keep and not r["user_edited"]:
                conn.execute(f"UPDATE {table} SET deleted_at = ? WHERE id = ?", (stamp, r["id"]))
    for r in conn.execute("SELECT id, item_key FROM notice_events WHERE notice_id = ? AND deleted_at IS NULL", (notice_id,)).fetchall():
        if r["item_key"] not in keep_ev:
            conn.execute("UPDATE notice_events SET deleted_at = ? WHERE id = ?", (stamp, r["id"]))


def _hide_derived(conn: sqlite3.Connection, notice_id: str) -> None:
    stamp = now_iso()
    for table in ("prep_items", "commute_exceptions", "notice_events"):
        conn.execute(f"UPDATE {table} SET deleted_at = ? WHERE notice_id = ? AND deleted_at IS NULL", (stamp, notice_id))


def _history(conn: sqlite3.Connection, notice_id: str, actor: str, action: str, snapshot: Optional[Dict[str, Any]] = None) -> None:
    conn.execute("INSERT INTO notice_history(notice_id, at, actor, action, snapshot) VALUES(?,?,?,?,?)",
                 (notice_id, now_iso(), actor, action, json.dumps(snapshot, ensure_ascii=False) if snapshot is not None else None))


def notice_json(r: sqlite3.Row, include_original: bool = False) -> Dict[str, Any]:
    dg = json.loads(r["digest"])
    out = {
        "id": r["id"], "source": r["source"], "sourceId": r["source_id"], "receivedOn": r["received_on"],
        "title": r["title"], "digest": dg, "status": r["status"], "editedByUser": bool(r["edited_by_user"]),
        "version": r["version"], "createdAt": r["created_at"], "updatedAt": r["updated_at"],
        "confirmedAt": r["confirmed_at"], "confirmedBy": r["confirmed_by"],
        "reviewReasons": review_reasons(dg) if r["status"] != "pending_analysis" else [],
        "hasOriginal": r["original_text"] is not None,
    }
    if include_original:
        out["originalText"] = r["original_text"]
    return out


def _status_for(dg: Dict[str, Any], settings: Dict[str, Any]) -> str:
    if review_reasons(dg):
        return "needs_review"
    return "auto" if settings["notices"].get("autoShowGeneral", True) else "needs_review"


def create_notice(conn: sqlite3.Connection, body: Dict[str, Any], actor: str, *, allow_sources: Iterable[str] = ("manual", "gongjitalk")) -> Dict[str, Any]:
    """새 공지를 저장한다. 같은 공지(출처 ID 또는 내용 해시)가 있으면 저장하지 않고 duplicate로 알린다."""
    if not isinstance(body, dict):
        raise StoreError(400, "VALIDATION_ERROR", "공지 형식이 올바르지 않아요.")
    source = body.get("source", "manual")
    if source not in allow_sources:
        raise StoreError(400, "VALIDATION_ERROR", "허용되지 않는 공지 출처예요.")
    received = _opt_date(body.get("receivedOn"))
    if not received:
        raise StoreError(400, "VALIDATION_ERROR", "공지 받은 날(receivedOn, YYYY-MM-DD)이 필요해요.")
    chash = body.get("contentHash")
    if not isinstance(chash, str) or not re.fullmatch(r"[0-9a-f]{64}", chash):
        raise StoreError(400, "VALIDATION_ERROR", "contentHash(sha-256 hex)가 필요해요.")
    source_id = _s(body.get("sourceId"), 80) or None
    dg = clean_digest(body.get("digest"))
    settings = get_settings(conn)
    original = body.get("originalText")
    store_original = isinstance(original, str) and original.strip() and (settings["notices"]["storeOriginal"] or body.get("storeOriginal") is True)
    original_text = original.strip()[:20000] if store_original else None
    with _tx(conn):
        dup = None
        if source_id:
            dup = conn.execute("SELECT * FROM notices WHERE source = ? AND source_id = ?", (source, source_id)).fetchone()
        if dup is None:
            dup = conn.execute("SELECT * FROM notices WHERE content_hash = ? AND deleted_at IS NULL", (chash,)).fetchone()
        if dup is not None and dup["deleted_at"] is None:
            return {"duplicate": True, "notice": notice_json(dup)}
        nid = new_id("ntc")
        status = _status_for(dg, settings)
        stamp = now_iso()
        if dup is not None:  # 예전에 지운 같은 출처 공지가 다시 들어오면 새 행으로 남기지 않고 되살린다
            nid = dup["id"]
            conn.execute("UPDATE notices SET content_hash=?, received_on=?, title=?, digest=?, original_text=?, status=?, edited_by_user=0, version=version+1, updated_at=?, updated_by=?, deleted_at=NULL, confirmed_at=NULL, confirmed_by=NULL WHERE id=?",
                         (chash, received, dg["title"], json.dumps(dg, ensure_ascii=False), original_text, status, stamp, actor, nid))
        else:
            conn.execute(
                "INSERT INTO notices(id, source, source_id, source_updated_at, content_hash, received_on, title, digest, original_text, status, created_at, updated_at, updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (nid, source, source_id, _s(body.get("sourceUpdatedAt"), 40) or None, chash, received, dg["title"],
                 json.dumps(dg, ensure_ascii=False), original_text, status, stamp, stamp, actor),
            )
        _apply_derived(conn, nid, dg, review=status == "needs_review")
        _history(conn, nid, actor, "create", dg)
        row = conn.execute("SELECT * FROM notices WHERE id = ?", (nid,)).fetchone()
    return {"duplicate": False, "notice": notice_json(row)}


def get_notice(conn: sqlite3.Connection, nid: str, include_original: bool = False) -> Dict[str, Any]:
    r = conn.execute("SELECT * FROM notices WHERE id = ? AND deleted_at IS NULL", (nid,)).fetchone()
    if not r:
        raise StoreError(404, "NOT_FOUND", "없는 공지예요.")
    return notice_json(r, include_original)


def list_notices(conn: sqlite3.Connection, status: Optional[str] = None) -> List[Dict[str, Any]]:
    q = "SELECT * FROM notices WHERE deleted_at IS NULL"
    args: List[Any] = []
    if status:
        q += " AND status = ?"
        args.append(status)
    q += " ORDER BY received_on DESC, created_at DESC LIMIT ?"
    args.append(NOTICE_LIST_LIMIT)
    return [notice_json(r) for r in conn.execute(q, args)]


def update_notice(conn: sqlite3.Connection, nid: str, body: Dict[str, Any], actor: str) -> Dict[str, Any]:
    if not isinstance(body, dict) or not isinstance(body.get("baseVersion"), int):
        raise StoreError(400, "VALIDATION_ERROR", "baseVersion과 digest가 필요해요.")
    dg = clean_digest(body.get("digest"))
    received = _opt_date(body.get("receivedOn"))
    with _tx(conn):
        r = conn.execute("SELECT * FROM notices WHERE id = ? AND deleted_at IS NULL", (nid,)).fetchone()
        if not r:
            raise StoreError(404, "NOT_FOUND", "없는 공지예요.")
        if r["version"] != body["baseVersion"]:
            raise StoreError(409, "VERSION_CONFLICT", "다른 기기가 먼저 이 공지를 고쳤어요.", {"version": r["version"]})
        _history(conn, nid, actor, "edit_before", json.loads(r["digest"]))
        # 보호자가 직접 고친 결과는 확인한 것으로 본다
        stamp = now_iso()
        conn.execute("UPDATE notices SET digest=?, title=?, received_on=?, edited_by_user=1, status='confirmed', confirmed_at=?, confirmed_by=?, version=version+1, updated_at=?, updated_by=? WHERE id=?",
                     (json.dumps(dg, ensure_ascii=False), dg["title"], received or r["received_on"], stamp, actor, stamp, actor, nid))
        _apply_derived(conn, nid, dg, review=False)
        _history(conn, nid, actor, "edit", dg)
        row = conn.execute("SELECT * FROM notices WHERE id = ?", (nid,)).fetchone()
    return notice_json(row)


def confirm_notice(conn: sqlite3.Connection, nid: str, base_version: Any, actor: str, dismiss: bool = False) -> Dict[str, Any]:
    if not isinstance(base_version, int):
        raise StoreError(400, "VALIDATION_ERROR", "baseVersion이 필요해요.")
    with _tx(conn):
        r = conn.execute("SELECT * FROM notices WHERE id = ? AND deleted_at IS NULL", (nid,)).fetchone()
        if not r:
            raise StoreError(404, "NOT_FOUND", "없는 공지예요.")
        if r["version"] != base_version:
            raise StoreError(409, "VERSION_CONFLICT", "다른 기기가 먼저 이 공지를 바꿨어요.", {"version": r["version"]})
        if r["status"] == "pending_analysis":
            raise StoreError(409, "NOT_ANALYZED", "아직 분석되지 않은 공지예요.")
        stamp = now_iso()
        status = "dismissed" if dismiss else "confirmed"
        conn.execute("UPDATE notices SET status=?, confirmed_at=?, confirmed_by=?, version=version+1, updated_at=?, updated_by=? WHERE id=?",
                     (status, stamp, actor, stamp, actor, nid))
        if dismiss:
            _hide_derived(conn, nid)
        else:
            for table in ("prep_items", "commute_exceptions", "notice_events"):
                conn.execute(f"UPDATE {table} SET needs_review = 0, updated_at = ? WHERE notice_id = ? AND deleted_at IS NULL", (stamp, nid))
        _history(conn, nid, actor, status)
        row = conn.execute("SELECT * FROM notices WHERE id = ?", (nid,)).fetchone()
    return notice_json(row)


def delete_notice(conn: sqlite3.Connection, nid: str, actor: str) -> None:
    with _tx(conn):
        r = conn.execute("SELECT digest FROM notices WHERE id = ? AND deleted_at IS NULL", (nid,)).fetchone()
        if not r:
            raise StoreError(404, "NOT_FOUND", "없는 공지예요.")
        stamp = now_iso()
        conn.execute("UPDATE notices SET deleted_at=?, original_text=NULL, version=version+1, updated_at=?, updated_by=? WHERE id=?", (stamp, stamp, actor, nid))
        _hide_derived(conn, nid)
        _history(conn, nid, actor, "delete", json.loads(r["digest"]))


def notice_history(conn: sqlite3.Connection, nid: str) -> List[Dict[str, Any]]:
    return [{"at": r["at"], "actor": r["actor"], "action": r["action"]}
            for r in conn.execute("SELECT at, actor, action FROM notice_history WHERE notice_id = ? ORDER BY id DESC LIMIT 50", (nid,))]


def import_notices(conn: sqlite3.Connection, items: Any, actor: str, preview: bool) -> Dict[str, Any]:
    """공지톡 JSON 가져오기. 미리보기면 저장하지 않고 항목별 결과만 돌려준다."""
    if not isinstance(items, list) or len(items) > 200:
        raise StoreError(400, "VALIDATION_ERROR", "가져올 공지 목록(최대 200건)이 필요해요.")
    results = []
    for i, it in enumerate(items):
        try:
            if not isinstance(it, dict):
                raise StoreError(400, "VALIDATION_ERROR", "항목 형식이 올바르지 않아요.")
            body = {**it, "source": "gongjitalk"}
            chash = body.get("contentHash")
            sid = _s(body.get("sourceId"), 80)
            exists = None
            if isinstance(chash, str):
                exists = conn.execute("SELECT id FROM notices WHERE deleted_at IS NULL AND (content_hash = ? OR (source='gongjitalk' AND source_id = ?))", (chash, sid)).fetchone()
            if preview:
                clean_digest(body.get("digest"))
                if not _opt_date(body.get("receivedOn")) or not isinstance(chash, str) or not re.fullmatch(r"[0-9a-f]{64}", chash):
                    raise StoreError(400, "VALIDATION_ERROR", "받은 날짜나 해시가 없어요.")
                results.append({"index": i, "status": "duplicate" if exists else "new", "title": _s(body["digest"].get("title"), 80)})
            else:
                res = create_notice(conn, body, actor, allow_sources=("gongjitalk",))
                results.append({"index": i, "status": "duplicate" if res["duplicate"] else "created", "id": res["notice"]["id"], "title": res["notice"]["title"]})
        except StoreError as e:
            results.append({"index": i, "status": "invalid", "error": e.message})
    summary = {k: sum(1 for r in results if r["status"] == k) for k in ("new", "created", "duplicate", "invalid")}
    return {"preview": preview, "results": results, "summary": summary}


# ───────────────────────── 준비물 ─────────────────────────


def _prep_json(r: sqlite3.Row) -> Dict[str, Any]:
    return {"id": r["id"], "noticeId": r["notice_id"], "childId": r["child_id"], "date": r["date"], "kind": r["kind"],
            "text": r["text"], "needsReview": bool(r["needs_review"]), "userEdited": bool(r["user_edited"]),
            "doneAt": r["done_at"], "doneBy": r["done_by"],
            "noticeTitle": r["notice_title"] if "notice_title" in r.keys() else None}


def list_prep(conn: sqlite3.Connection, start: str, end: str, include_undated: bool = True) -> List[Dict[str, Any]]:
    q = ("SELECT p.*, n.title AS notice_title FROM prep_items p LEFT JOIN notices n ON n.id = p.notice_id "
         "WHERE p.deleted_at IS NULL AND (n.id IS NULL OR (n.deleted_at IS NULL AND n.status != 'dismissed')) AND "
         + ("((p.date BETWEEN ? AND ?) OR p.date IS NULL)" if include_undated else "(p.date BETWEEN ? AND ?)")
         + " ORDER BY p.date IS NULL, p.date, p.kind, p.created_at")
    return [_prep_json(r) for r in conn.execute(q, (start, end))]


def add_prep(conn: sqlite3.Connection, body: Dict[str, Any], actor: str) -> Dict[str, Any]:
    if not isinstance(body, dict):
        raise StoreError(400, "VALIDATION_ERROR", "준비물 형식이 올바르지 않아요.")
    text = _s(body.get("text"), 120)
    kind = body.get("kind")
    d = _opt_date(body.get("date"))
    if not text or kind not in ("dropoff", "pickup", "event", "document", "parent_task") or not d:
        raise StoreError(400, "VALIDATION_ERROR", "날짜·종류·내용을 확인해 주세요.")
    stamp = now_iso()
    pid = new_id("prep")
    with _tx(conn):
        conn.execute("INSERT INTO prep_items(id, item_key, child_id, date, kind, text, user_edited, created_at, updated_at) VALUES(?,?,?,?,?,?,1,?,?)",
                     (pid, _key("manual", pid), _s(body.get("childId"), 64) or None, d, kind, text, stamp, stamp))
        row = conn.execute("SELECT * FROM prep_items WHERE id = ?", (pid,)).fetchone()
    return _prep_json(row)


def update_prep(conn: sqlite3.Connection, pid: str, body: Dict[str, Any], actor: str) -> Dict[str, Any]:
    if not isinstance(body, dict):
        raise StoreError(400, "VALIDATION_ERROR", "형식이 올바르지 않아요.")
    with _tx(conn):
        r = conn.execute("SELECT * FROM prep_items WHERE id = ? AND deleted_at IS NULL", (pid,)).fetchone()
        if not r:
            raise StoreError(404, "NOT_FOUND", "없는 항목이에요.")
        stamp = now_iso()
        if "done" in body:
            conn.execute("UPDATE prep_items SET done_at=?, done_by=?, updated_at=? WHERE id=?",
                         (stamp if body["done"] else None, actor if body["done"] else None, stamp, pid))
        changes = {}
        if "text" in body:
            t = _s(body.get("text"), 120)
            if not t:
                raise StoreError(400, "VALIDATION_ERROR", "내용을 입력해 주세요.")
            changes["text"] = t
        if "date" in body:
            changes["date"] = _opt_date(body.get("date"))
        if "kind" in body:
            if body["kind"] not in ("dropoff", "pickup", "event", "document", "parent_task"):
                raise StoreError(400, "VALIDATION_ERROR", "종류를 확인해 주세요.")
            changes["kind"] = body["kind"]
        if body.get("deleted") is True:
            changes["deleted_at"] = stamp
        if changes:
            sets = ", ".join(f"{k}=?" for k in changes)
            conn.execute(f"UPDATE prep_items SET {sets}, user_edited=1, needs_review=0, updated_at=? WHERE id=?", (*changes.values(), stamp, pid))
        row = conn.execute("SELECT * FROM prep_items WHERE id = ?", (pid,)).fetchone()
    return _prep_json(row)


# ───────────────────────── 등하원 ─────────────────────────


def list_exceptions(conn: sqlite3.Connection, start: str, end: str) -> List[Dict[str, Any]]:
    rows = conn.execute(
        "SELECT e.*, n.title AS notice_title FROM commute_exceptions e LEFT JOIN notices n ON n.id = e.notice_id "
        "WHERE e.deleted_at IS NULL AND (n.id IS NULL OR (n.deleted_at IS NULL AND n.status != 'dismissed')) "
        "AND e.date <= ? AND COALESCE(e.end_date, e.date) >= ? ORDER BY e.date", (end, start)).fetchall()
    return [{"id": r["id"], "noticeId": r["notice_id"], "childId": r["child_id"], "date": r["date"], "endDate": r["end_date"],
             "kind": r["kind"], "time": r["time"], "note": r["note"], "needsReview": bool(r["needs_review"]),
             "noticeTitle": r["notice_title"]} for r in rows]


def add_exception(conn: sqlite3.Connection, body: Dict[str, Any], actor: str) -> Dict[str, Any]:
    if not isinstance(body, dict):
        raise StoreError(400, "VALIDATION_ERROR", "형식이 올바르지 않아요.")
    kind, d = body.get("kind"), _opt_date(body.get("date"))
    t = _opt_time(body.get("time"))
    if kind not in ("closed", "dropoff_time", "pickup_time") or not d or (kind != "closed" and not t):
        raise StoreError(400, "VALIDATION_ERROR", "날짜·종류·시각을 확인해 주세요.")
    end = _opt_date(body.get("endDate"))
    if end and end < d:
        raise StoreError(400, "VALIDATION_ERROR", "끝 날짜가 시작 날짜보다 빨라요.")
    eid = new_id("exc")
    stamp = now_iso()
    with _tx(conn):
        conn.execute("INSERT INTO commute_exceptions(id, item_key, child_id, date, end_date, kind, time, note, user_edited, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)",
                     (eid, _key("manual", eid), _s(body.get("childId"), 64) or None, d, end, kind, t, _s(body.get("note"), 120), stamp, stamp))
    return next(e for e in list_exceptions(conn, d, end or d) if e["id"] == eid)


def delete_exception(conn: sqlite3.Connection, eid: str) -> None:
    with _tx(conn):
        cur = conn.execute("UPDATE commute_exceptions SET deleted_at=?, user_edited=1 WHERE id=? AND deleted_at IS NULL", (now_iso(), eid))
        if cur.rowcount == 0:
            raise StoreError(404, "NOT_FOUND", "없는 항목이에요.")


def _minus(t: str, minutes: int) -> str:
    h, m = map(int, t.split(":"))
    total = max(0, h * 60 + m - minutes)
    return f"{total // 60:02d}:{total % 60:02d}"


def _minutes(t: str) -> int:
    h, m = map(int, t.split(":"))
    return h * 60 + m


def commute_day(settings: Dict[str, Any], exceptions: List[Dict[str, Any]], child_id: str, d: str) -> Optional[Dict[str, Any]]:
    """한 아이의 하루 등하원 계획. 설정이 없으면 None."""
    c = settings["commute"]["children"].get(child_id)
    if not c:
        return None
    wd = str(iso_weekday(d))
    mine = [e for e in exceptions if (e["childId"] in (None, child_id)) and e["date"] <= d <= (e["endDate"] or e["date"])]
    closed = next((e for e in mine if e["kind"] == "closed"), None)
    attends = iso_weekday(d) in c["weekdays"]
    plan: Dict[str, Any] = {
        "childId": child_id, "date": d, "attends": attends and not closed,
        "closed": closed is not None, "closedNote": closed["note"] if closed else None,
        "leaveHomeAt": c["leaveHomeAt"], "arriveBy": c["arriveBy"],
        "pickupAt": c["pickupAtByWeekday"].get(wd, c["pickupAt"]),
        "pickupAssignee": c["pickupAssigneeByWeekday"].get(wd, c["pickupAssignee"]) or None,
        "changes": [], "needsReview": bool(closed and closed["needsReview"]),
    }
    lead = _minutes(c["arriveBy"]) - _minutes(c["leaveHomeAt"])
    for e in mine:
        if e["kind"] == "dropoff_time" and e["time"]:
            plan["arriveBy"] = e["time"]
            plan["leaveHomeAt"] = _minus(e["time"], lead)
            plan["changes"].append({"kind": "dropoff_time", "time": e["time"], "note": e["note"], "needsReview": e["needsReview"], "noticeId": e["noticeId"]})
            plan["needsReview"] = plan["needsReview"] or e["needsReview"]
        elif e["kind"] == "pickup_time" and e["time"]:
            plan["pickupAt"] = e["time"]
            plan["changes"].append({"kind": "pickup_time", "time": e["time"], "note": e["note"], "needsReview": e["needsReview"], "noticeId": e["noticeId"]})
            plan["needsReview"] = plan["needsReview"] or e["needsReview"]
    return plan


# ───────────────────────── 픽업 ─────────────────────────


def pickups_for(conn: sqlite3.Connection, settings: Dict[str, Any], child_ids: List[str], start: str, end: str,
                exceptions: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    exceptions = exceptions if exceptions is not None else list_exceptions(conn, start, end)
    rows = {(r["date"], r["child_id"]): r for r in conn.execute("SELECT * FROM pickups WHERE date BETWEEN ? AND ?", (start, end))}
    out = []
    d = start
    while d <= end:
        for cid in child_ids:
            plan = commute_day(settings, exceptions, cid, d)
            r = rows.get((d, cid))
            if plan is None and r is None:
                continue
            explicit = r["assignee"] if r and r["assignee"] else None
            out.append({
                "date": d, "childId": cid,
                "assignee": explicit or (plan["pickupAssignee"] if plan else None),
                "assigneeSource": "manual" if explicit else ("default" if plan and plan["pickupAssignee"] else None),
                "pickupAt": plan["pickupAt"] if plan else None,
                "attends": plan["attends"] if plan else True,
                "doneAt": r["done_at"] if r else None, "doneBy": r["done_by"] if r else None,
            })
        d = add_days(d, 1)
    return out


def set_pickup(conn: sqlite3.Connection, body: Dict[str, Any], actor: str) -> None:
    if not isinstance(body, dict):
        raise StoreError(400, "VALIDATION_ERROR", "형식이 올바르지 않아요.")
    d, cid = _opt_date(body.get("date")), _s(body.get("childId"), 64)
    if not d or not cid:
        raise StoreError(400, "VALIDATION_ERROR", "날짜와 아이를 확인해 주세요.")
    stamp = now_iso()
    with _tx(conn):
        cur = conn.execute("SELECT * FROM pickups WHERE date = ? AND child_id = ?", (d, cid)).fetchone()
        assignee = cur["assignee"] if cur else None
        done_at = cur["done_at"] if cur else None
        done_by = cur["done_by"] if cur else None
        if "assignee" in body:
            assignee = _s(body.get("assignee"), 20) or None
        if "done" in body:
            done_at, done_by = (stamp, actor) if body["done"] else (None, None)
        conn.execute("INSERT INTO pickups(date, child_id, assignee, done_at, done_by, updated_at, updated_by) VALUES(?,?,?,?,?,?,?) "
                     "ON CONFLICT(date, child_id) DO UPDATE SET assignee=excluded.assignee, done_at=excluded.done_at, done_by=excluded.done_by, updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                     (d, cid, assignee, done_at, done_by, stamp, actor))


# ───────────────────────── 공지 행사 ↔ 캘린더 ─────────────────────────


def list_notice_events(conn: sqlite3.Connection, start: str, end: str) -> List[Dict[str, Any]]:
    rows = conn.execute(
        "SELECT e.*, n.status AS notice_status FROM notice_events e JOIN notices n ON n.id = e.notice_id "
        "WHERE e.deleted_at IS NULL AND n.deleted_at IS NULL AND n.status != 'dismissed' "
        "AND e.date <= ? AND COALESCE(e.end_date, e.date) >= ? ORDER BY e.date, e.time", (end, start)).fetchall()
    return [{"id": r["id"], "noticeId": r["notice_id"], "date": r["date"], "endDate": r["end_date"], "time": r["time"],
             "title": r["title"], "kind": r["kind"], "needsReview": bool(r["needs_review"]),
             "calendarEventId": r["calendar_event_id"], "calendarSnapshot": json.loads(r["calendar_snapshot"]) if r["calendar_snapshot"] else None}
            for r in rows]


def link_notice_event(conn: sqlite3.Connection, ev_id: str, body: Dict[str, Any]) -> None:
    if not isinstance(body, dict):
        raise StoreError(400, "VALIDATION_ERROR", "형식이 올바르지 않아요.")
    cal = body.get("calendarEventId")
    snap = body.get("snapshot")
    if cal is not None and (not isinstance(cal, str) or len(cal) > 64):
        raise StoreError(400, "VALIDATION_ERROR", "calendarEventId를 확인해 주세요.")
    with _tx(conn):
        cur = conn.execute("UPDATE notice_events SET calendar_event_id=?, calendar_snapshot=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
                           (cal, json.dumps(snap, ensure_ascii=False) if isinstance(snap, dict) and cal else None, now_iso(), ev_id))
        if cur.rowcount == 0:
            raise StoreError(404, "NOT_FOUND", "없는 공지 일정이에요.")
