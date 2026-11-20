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
    wx = weather.snapshot(conn, settings["location"], today, drop, pick, t_drop)

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
    return {
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
