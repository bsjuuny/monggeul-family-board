"""메인 보드·TV 화면에 필요한 정보를 한 번에 모은다 (GET /api/board).

TV 기기도 이 응답을 받으므로 나만 보기 일정·공지 원문·계정 정보는 넣지 않는다.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import board_store as bs
import display
import kidsnote


def screen_mode(screen: Dict[str, str], now: datetime) -> str:
    hm = now.astimezone(bs.KST).strftime("%H:%M")
    if screen["morningFrom"] <= hm < screen["afternoonFrom"]:
        return "morning"
    if screen["afternoonFrom"] <= hm < screen["eveningFrom"]:
        return "afternoon"
    return "evening"


def _family_doc(conn: sqlite3.Connection) -> Optional[Dict[str, Any]]:
    row = conn.execute("SELECT data FROM family_doc WHERE id = 1").fetchone()
    data = json.loads(row["data"]) if row else None
    return data if isinstance(data, dict) else None


def _notice_card(n: Dict[str, Any]) -> Dict[str, Any]:
    dg = n["digest"]
    return {"id": n["id"], "title": n["title"], "status": n["status"], "reviewReasons": n["reviewReasons"],
            "receivedOn": n["receivedOn"], "eventDate": dg.get("eventDate"), "needsReply": dg.get("needsReply", False),
            "source": n["source"]}


def build(conn: sqlite3.Connection, weather: Any, adapter: Any, viewer: Dict[str, Any],
          now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    today = bs.today_kst(now)
    tomorrow = bs.add_days(today, 1)
    doc = _family_doc(conn)
    fam = display.family_of(doc)
    settings = bs.get_settings(conn)
    kids = display.children_of(doc)
    habits = display.habits_today(doc, today)
    exceptions = bs.list_exceptions(conn, today, tomorrow)
    plans = {d: [p for p in (bs.commute_day(settings, exceptions, c["id"], d) for c in kids) if p] for d in (today, tomorrow)}
    attending_today = [p for p in plans[today] if p["attends"]]
    attending_tomorrow = [p for p in plans[tomorrow] if p["attends"]]
    drop = min((p["leaveHomeAt"] for p in attending_today), default=None)
    pick = min((p["pickupAt"] for p in attending_today), default=None)
    t_drop = min((p["leaveHomeAt"] for p in attending_tomorrow), default=None)
    t_pick = min((p["pickupAt"] for p in attending_tomorrow), default=None)
    wx = weather.snapshot(conn, settings["location"], today, drop, pick, t_drop, t_pick)

    notices = [n for n in bs.list_notices(conn) if n["status"] not in ("dismissed",)]
    review = [n for n in notices if n["status"] in ("needs_review", "pending_analysis")]
    upcoming = sorted((n for n in notices if n["status"] in ("auto", "confirmed") and (n["digest"].get("eventDate") or "") >= today),
                      key=lambda n: n["digest"]["eventDate"])
    recent = [n for n in notices if n["status"] in ("auto", "confirmed") and n not in upcoming][:3]
    top = (review + upcoming + recent)[:5]

    prep = bs.list_prep(conn, today, tomorrow, include_undated=False)
    cal = display.public_events(doc, today, tomorrow)
    nev = bs.list_notice_events(conn, today, tomorrow)

    def events_on(d: str) -> List[Dict[str, Any]]:
        out = []
        for e in cal:
            span = display._event_span(e)
            if span and span[0] <= d <= span[1]:
                out.append(e)
        shown = {c["id"] for c in out}
        for e in nev:
            # 캘린더에 이미 연결해 보이는 공지 일정은 두 번 보여 주지 않는다
            if e["date"] <= d <= (e["endDate"] or e["date"]) and not (e["calendarEventId"] and e["calendarEventId"] in shown):
                out.append({"id": e["id"], "title": e["title"], "allDay": e["time"] is None, "startDate": e["date"], "endDate": e["endDate"],
                            "startsAt": None, "endsAt": None, "time": e["time"], "source": "notice", "noticeId": e["noticeId"],
                            "needsReview": e["needsReview"]})
        return out

    st = kidsnote.get_state(conn)
    cfg = settings["kidsnote"]
    out = {
        "serverTime": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "today": today, "tomorrow": tomorrow,
        "family": fam, "viewer": viewer,
        "screen": {**settings["screen"], "mode": screen_mode(settings["screen"], now)},
        "children": [{**c, "habits": habits.get(c["id"], {"done": 0, "total": 0, "pending": 0})} for c in kids],
        "commute": {"configured": bool(settings["commute"]["children"]), "today": plans[today], "tomorrow": plans[tomorrow]},
        "weather": wx,
        "notices": {"needsReview": len(review), "top": [_notice_card(n) for n in top]},
        "prep": {"today": [p for p in prep if p["date"] == today], "tomorrow": [p for p in prep if p["date"] == tomorrow]},
        "pickups": bs.pickups_for(conn, settings, [c["id"] for c in kids], today, today, exceptions),
        "events": {"today": events_on(today), "tomorrow": events_on(tomorrow)},
        "tasks": display.tasks_today(doc, today),
        "sync": {"name": adapter.name, "mode": adapter.mode, "available": adapter.available(), "enabled": cfg["enabled"],
                 "lastOkAt": st["lastOkAt"], "lastError": st["lastError"], "paused": st["paused"]},
    }
    if viewer.get("kind") == "device":
        apply_tv_privacy(out, settings["tvPrivacy"])
    return out


def _scrub(v: Any, names: List[str], to: str) -> Any:
    """응답 안의 모든 문자열에서 아이 이름을 지운다(공지 제목·준비물·메모에 섞인 이름까지)."""
    if isinstance(v, str):
        for n in names:
            v = v.replace(n, to)
        return v
    if isinstance(v, list):
        return [_scrub(x, names, to) for x in v]
    if isinstance(v, dict):
        return {k: _scrub(x, names, to) for k, x in v.items()}
    return v


def apply_tv_privacy(b: Dict[str, Any], p: Dict[str, bool]) -> None:
    """TV(거실 화면)에서 가릴 정보를 지운다. 보호자 화면에는 적용하지 않는다."""
    b["privacy"] = p
    # TV 화면은 준비물의 원 공지 제목을 쓰지 않는다: 항상 뺀다
    for d in ("today", "tomorrow"):
        for item in b["prep"][d]:
            item["noticeTitle"] = None
    if p.get("hideChildNames"):
        names = sorted({c["displayName"] for c in b["children"] if c.get("displayName")}, key=len, reverse=True)
        for k in ("notices", "prep", "events", "commute", "pickups", "tasks"):
            b[k] = _scrub(b[k], names, "아이")
    if p.get("hideChildNames"):
        for i, c in enumerate(b["children"]):
            c["displayName"] = "우리 아이" if len(b["children"]) == 1 else f"아이 {i + 1}"
    if p.get("hideNoticeTitles"):
        for d in ("today", "tomorrow"):
            for plan in b["commute"][d]:
                if plan.get("closedNote"):
                    plan["closedNote"] = "어린이집 안내"
                for c in plan.get("changes", []):
                    c["note"] = None
        for n in b["notices"]["top"]:
            n["title"] = "확인할 공지" if n["status"] in ("needs_review", "pending_analysis") else "새 공지"
        for d in ("today", "tomorrow"):
            for e in b["events"][d]:
                if e.get("source") == "notice":
                    e["title"] = "어린이집 일정"
    if p.get("hidePickup"):
        for pk in b["pickups"]:
            pk["assignee"] = None
            pk["assigneeSource"] = None
        for d in ("today", "tomorrow"):
            for plan in b["commute"][d]:
                plan["pickupAssignee"] = None
