"""가족 문서(JSON)에서 보드·TV에 보여 줄 공개 정보만 뽑는다.

가족 문서의 모양은 프론트 src/repo/demoRepository.ts 의 DemoState 를 따른다.
나만 보기(private) 일정, 계정·초대·비밀 값은 절대 내보내지 않는다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

KST = timezone(timedelta(hours=9))


def _kst_date(iso: Optional[str]) -> Optional[str]:
    if not isinstance(iso, str) or not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(KST).date().isoformat()
    except ValueError:
        return None


def _event_span(e: Dict[str, Any]) -> Optional[tuple]:
    if e.get("allDay"):
        s = e.get("startDate")
        if not isinstance(s, str):
            return None
        return s, e.get("endDate") or s
    s = _kst_date(e.get("startsAt"))
    if not s:
        return None
    end = _kst_date(e.get("endsAt")) or s
    return s, max(s, end)


def family_of(doc: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    fams = (doc or {}).get("families") or []
    f = fams[0] if fams and isinstance(fams[0], dict) else {}
    return {"id": f.get("id"), "name": f.get("name") or "우리 가족", "timezone": f.get("timezone") or "Asia/Seoul"}


def children_of(doc: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    fam = family_of(doc)["id"]
    out = []
    for c in (doc or {}).get("children") or []:
        if isinstance(c, dict) and c.get("active") and (fam is None or c.get("familyId") in (None, fam)):
            out.append({"id": c.get("id"), "displayName": c.get("displayName") or "아이", "avatarKey": c.get("avatarKey") or "monggeul"})
    return out


def adults_of(doc: Optional[Dict[str, Any]]) -> List[str]:
    names = []
    for m in (doc or {}).get("members") or []:
        if isinstance(m, dict) and isinstance(m.get("displayName"), str) and m["displayName"].strip():
            names.append(m["displayName"].strip()[:20])
    return names


def public_events(doc: Optional[Dict[str, Any]], start: str, end: str) -> List[Dict[str, Any]]:
    out = []
    for e in (doc or {}).get("events") or []:
        if not isinstance(e, dict) or e.get("visibility") != "family":
            continue
        span = _event_span(e)
        if not span or span[0] > end or span[1] < start:
            continue
        out.append({"id": e.get("id"), "title": str(e.get("title") or "")[:80], "allDay": bool(e.get("allDay")),
                    "startDate": e.get("startDate"), "endDate": e.get("endDate"),
                    "startsAt": e.get("startsAt"), "endsAt": e.get("endsAt"), "source": "calendar"})
    out.sort(key=lambda x: (x["startsAt"] or (x["startDate"] or "") + "T00:00:00Z"))
    return out[:20]


def tasks_today(doc: Optional[Dict[str, Any]], today: str) -> Dict[str, List[Dict[str, Any]]]:
    todo, shopping = [], []
    for t in (doc or {}).get("tasks") or []:
        if not isinstance(t, dict):
            continue
        done = t.get("completedAt")
        item = {"id": t.get("id"), "title": str(t.get("title") or "")[:80], "dueAt": t.get("dueAt"), "done": bool(done)}
        if t.get("kind") == "shopping":
            if not done:
                item.update({"quantity": t.get("quantity"), "unit": t.get("unit")})
                shopping.append(item)
        elif not done or _kst_date(done) == today:
            todo.append(item)
    todo.sort(key=lambda x: (x["done"], x["dueAt"] or "9999"))
    return {"todo": todo[:8], "shopping": shopping[:8]}


def habits_today(doc: Optional[Dict[str, Any]], today: str) -> Dict[str, Dict[str, int]]:
    d = doc or {}
    kids = {c["id"] for c in children_of(doc)}
    out: Dict[str, Dict[str, int]] = {k: {"done": 0, "total": 0, "pending": 0} for k in kids}
    templates = [h for h in d.get("habitTemplates") or [] if isinstance(h, dict) and h.get("active") and h.get("childId") in kids]
    records = [r for r in d.get("habitRecords") or [] if isinstance(r, dict) and r.get("localDate") == today]
    for h in templates:
        st = next((r.get("state") for r in records if r.get("habitId") == h.get("id")), None)
        o = out[h["childId"]]
        o["total"] += 1
        if st in ("done", "approved"):
            o["done"] += 1
        elif st == "pending":
            o["pending"] += 1
    return out
