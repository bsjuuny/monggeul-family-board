"""공지 자동 수집: 어댑터 인터페이스 + 동기화 엔진 + 예약 실행.

키즈노트 실제 연동 상태(2026-11-20):
  - 키즈노트는 공식 API·개발자 프로그램이 확인되지 않았다(웹사이트 탐색 기준).
  - 서비스 이용약관(2025-08-11 시행)에 자동 수집을 명시적으로 허용하는 조항이 없다.
  - 사용자 결정: 키즈노트에 문의한 뒤 결정. 그때까지 실제 키즈노트 호출 코드는 넣지 않는다.
  따라서 OfficialKidsnoteAdapter 는 항상 사용할 수 없음(available=False)이고, 개발·QA 에서는
  MockAdapter(--notice-source mock:<파일>)로 같은 파이프라인을 검증한다.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Protocol

import board_store as bs
from analyzer_bridge import AnalyzerUnavailable, content_hash

KST = timezone(timedelta(hours=9))
SOURCE_KEY = "kidsnote"
MAX_FAILURES_BEFORE_PAUSE = 5
MIN_MANUAL_INTERVAL = 60


@dataclass
class SourceItem:
    source_id: str
    kind: str            # 'notice' | 'report'
    posted_at: str       # ISO
    updated_at: str      # ISO
    title: str
    text: str
    author_type: str     # 'teacher' | 'admin' | 'parent'


class NoticeSourceAdapter(Protocol):
    name: str
    mode: str            # 'official' | 'mock'

    def available(self) -> bool: ...
    def unavailable_reason(self) -> Optional[str]: ...
    def fetch(self, since: Optional[str]) -> List[SourceItem]: ...


class OfficialKidsnoteAdapter:
    """공식 연동 수단이 확보되면 여기에 구현한다. 지금은 항상 꺼져 있다."""
    name = "키즈노트"
    mode = "official"

    def available(self) -> bool:
        return False

    def unavailable_reason(self) -> Optional[str]:
        return ("키즈노트 공식 연동 수단(API·제휴)을 아직 확인하지 못해 실제 수집은 꺼져 있어요. "
                "공지는 붙여넣기나 공지톡 가져오기로 넣어 주세요.")

    def fetch(self, since: Optional[str]) -> List[SourceItem]:  # pragma: no cover - 호출되지 않음
        raise RuntimeError("공식 연동 수단이 없어요.")


class MockAdapter:
    """JSON 파일의 공지를 키즈노트처럼 돌려준다(개발·QA 전용)."""
    name = "키즈노트(모의)"
    mode = "mock"

    def __init__(self, path: Path):
        self.path = path

    def available(self) -> bool:
        return self.path.is_file()

    def unavailable_reason(self) -> Optional[str]:
        return None if self.available() else f"모의 데이터 파일이 없어요: {self.path.name}"

    def fetch(self, since: Optional[str]) -> List[SourceItem]:
        data = json.loads(self.path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("fail"):
            raise RuntimeError(str(data.get("fail")))
        out = []
        for x in data if isinstance(data, list) else data.get("items", []):
            out.append(SourceItem(str(x["id"]), x.get("kind", "notice"), x["postedAt"], x.get("updatedAt") or x["postedAt"],
                                  x.get("title", ""), x.get("text", ""), x.get("authorType", "teacher")))
        return out


def adapter_from_spec(spec: Optional[str]) -> NoticeSourceAdapter:
    if spec and spec.startswith("mock:"):
        return MockAdapter(Path(spec[5:]).expanduser())
    return OfficialKidsnoteAdapter()


# ───── 상태 ─────
def get_state(conn: sqlite3.Connection) -> Dict[str, Any]:
    row = conn.execute("SELECT state FROM sync_state WHERE source = ?", (SOURCE_KEY,)).fetchone()
    base = {"cursor": None, "lastRunAt": None, "lastOkAt": None, "lastError": None, "failures": 0,
            "nextAllowedAt": None, "paused": False, "lastSlot": None}
    if row:
        base.update(json.loads(row["state"]))
    return base


def _put_state(conn: sqlite3.Connection, st: Dict[str, Any]) -> None:
    conn.execute("INSERT INTO sync_state(source, state, updated_at) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at",
                 (SOURCE_KEY, json.dumps(st, ensure_ascii=False), bs.now_iso()))


def status(conn: sqlite3.Connection, adapter: NoticeSourceAdapter) -> Dict[str, Any]:
    st = get_state(conn)
    settings = bs.get_settings(conn)["kidsnote"]
    runs = [dict(r) for r in conn.execute("SELECT trigger, started_at, finished_at, ok, fetched, created, updated, skipped, error FROM sync_runs WHERE source = ? ORDER BY id DESC LIMIT 10", (SOURCE_KEY,))]
    return {
        "adapter": {"name": adapter.name, "mode": adapter.mode, "available": adapter.available(), "reason": adapter.unavailable_reason()},
        "settings": settings,
        "state": {k: st[k] for k in ("lastRunAt", "lastOkAt", "lastError", "failures", "nextAllowedAt", "paused")},
        "runs": runs,
    }


def _backoff(failures: int) -> int:
    return min(6 * 3600, 15 * 60 * (2 ** max(0, failures - 1)))


# ───── 동기화 ─────
def run_sync(conn: sqlite3.Connection, adapter: NoticeSourceAdapter, analyzer: Any, trigger: str,
             now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    if not adapter.available():
        raise bs.StoreError(409, "SOURCE_NOT_AVAILABLE", adapter.unavailable_reason() or "수집할 수 없어요.")
    st = get_state(conn)
    if trigger == "schedule":
        if st["paused"]:
            return {"skipped": "paused"}
        if st["nextAllowedAt"] and now.isoformat() < st["nextAllowedAt"]:
            return {"skipped": "backoff"}
    elif st["lastRunAt"] and (now - datetime.fromisoformat(st["lastRunAt"])).total_seconds() < MIN_MANUAL_INTERVAL:
        raise bs.StoreError(429, "RATE_LIMITED", "방금 동기화했어요. 1분 뒤 다시 눌러 주세요.")
    started = bs.now_iso()
    cur = conn.execute("INSERT INTO sync_runs(source, trigger, started_at) VALUES(?,?,?)", (SOURCE_KEY, trigger, started))
    run_id = cur.lastrowid
    counts = {"fetched": 0, "created": 0, "updated": 0, "skipped": 0}
    try:
        items = [i for i in adapter.fetch(st["cursor"]) if i.author_type in ("teacher", "admin")]
        counts["fetched"] = len(items)
        todo = []
        for it in items:
            existing = conn.execute("SELECT * FROM notices WHERE source = ? AND source_id = ?", (adapter.mode if adapter.mode == "mock" else "kidsnote", it.source_id)).fetchone()
            text = f"{it.title}\n{it.text}".strip()  # 줄바꿈을 살려 분석한다(해시는 정규화해서)
            h = content_hash(text)
            if existing is not None and existing["content_hash"] == h and existing["deleted_at"] is None:
                counts["skipped"] += 1
                continue
            if existing is not None and existing["deleted_at"] is not None and existing["content_hash"] == h:
                counts["skipped"] += 1  # 보호자가 지운 공지는 내용이 그대로면 되살리지 않는다
                continue
            received = datetime.fromisoformat(it.posted_at.replace("Z", "+00:00")).astimezone(KST).date().isoformat()
            todo.append((it, text, h, received, existing))
        analyzed: List[Optional[Dict[str, Any]]] = [None] * len(todo)
        if todo:
            try:
                res = analyzer.analyze([{"text": t, "receivedOn": r} for _, t, _, r, _ in todo])
                analyzed = [x.get("digest") for x in res]
            except AnalyzerUnavailable:
                pass  # 분석 대기로 저장
        source = "mock" if adapter.mode == "mock" else "kidsnote"
        for (it, text, h, received, existing), dg in zip(todo, analyzed):
            _upsert(conn, source, it, text, h, received, existing, dg)
            counts["updated" if existing is not None else "created"] += 1
        st.update({"lastRunAt": now.isoformat(), "lastOkAt": now.isoformat(), "lastError": None, "failures": 0, "nextAllowedAt": None,
                   "cursor": max([i.updated_at for i in items], default=st["cursor"])})
        ok, err = 1, None
    except bs.StoreError:
        raise
    except Exception as e:  # 원인 메시지에 인증 정보가 들어가지 않도록 형식만 남긴다
        failures = st["failures"] + 1
        err = f"{type(e).__name__}: {str(e)[:120]}"
        st.update({"lastRunAt": now.isoformat(), "lastError": err, "failures": failures,
                   "nextAllowedAt": (now + timedelta(seconds=_backoff(failures))).isoformat(),
                   "paused": failures >= MAX_FAILURES_BEFORE_PAUSE})
        ok = 0
    _put_state(conn, st)
    conn.execute("UPDATE sync_runs SET finished_at=?, ok=?, fetched=?, created=?, updated=?, skipped=?, error=? WHERE id=?",
                 (bs.now_iso(), ok, counts["fetched"], counts["created"], counts["updated"], counts["skipped"], err, run_id))
    return {"ok": bool(ok), **counts, "error": err}


def _upsert(conn: sqlite3.Connection, source: str, it: SourceItem, text: str, h: str, received: str,
            existing: Optional[sqlite3.Row], digest: Optional[Dict[str, Any]]) -> None:
    settings = bs.get_settings(conn)
    stamp = bs.now_iso()
    if digest is None:
        dg = bs.clean_digest({"title": (it.title or text)[:60] or "새 공지", "summary": "분석 대기 중"})
        status = "pending_analysis"
        original: Optional[str] = text  # 나중에 분석하려면 원문이 필요하다(분석 후 지운다)
    else:
        dg = bs.clean_digest(digest)
        status = bs._status_for(dg, settings)
        original = text if settings["notices"]["storeOriginal"] else None
    with bs._tx(conn):
        if existing is None:
            nid = bs.new_id("ntc")
            conn.execute(
                "INSERT INTO notices(id, source, source_id, source_updated_at, content_hash, received_on, title, digest, original_text, status, created_at, updated_at, updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (nid, source, it.source_id, it.updated_at, h, received, dg["title"], json.dumps(dg, ensure_ascii=False), original, status, stamp, stamp, "sync"))
            bs._history(conn, nid, "sync", "create", dg)
        else:
            nid = existing["id"]
            if existing["edited_by_user"]:
                # 보호자가 고친 결과는 덮어쓰지 않는다. 원본이 바뀌었음을 기록하고 다시 확인을 요청한다.
                bs._history(conn, nid, "sync", "source_changed", dg)
                conn.execute("UPDATE notices SET status='needs_review', content_hash=?, source_updated_at=?, version=version+1, updated_at=?, updated_by='sync', deleted_at=NULL WHERE id=?",
                             (h, it.updated_at, stamp, nid))
                return
            conn.execute("UPDATE notices SET content_hash=?, source_updated_at=?, received_on=?, title=?, digest=?, original_text=?, status=?, version=version+1, updated_at=?, updated_by='sync', deleted_at=NULL, confirmed_at=NULL, confirmed_by=NULL WHERE id=?",
                         (h, it.updated_at, received, dg["title"], json.dumps(dg, ensure_ascii=False), original, status, stamp, nid))
            bs._history(conn, nid, "sync", "source_update", dg)
        if status != "pending_analysis":
            bs._apply_derived(conn, nid, dg, review=status == "needs_review")


def save_analysis(conn: sqlite3.Connection, nid: str, digest: Any, actor: str) -> Dict[str, Any]:
    """분석 대기 공지를 브라우저가 분석해 보낸 결과로 채운다."""
    dg = bs.clean_digest(digest)
    settings = bs.get_settings(conn)
    with bs._tx(conn):
        r = conn.execute("SELECT * FROM notices WHERE id = ? AND deleted_at IS NULL", (nid,)).fetchone()
        if not r or r["status"] != "pending_analysis":
            raise bs.StoreError(409, "NOT_PENDING", "분석 대기 중인 공지가 아니에요.")
        status = bs._status_for(dg, settings)
        keep = r["original_text"] if settings["notices"]["storeOriginal"] else None
        conn.execute("UPDATE notices SET digest=?, title=?, status=?, original_text=?, version=version+1, updated_at=?, updated_by=? WHERE id=?",
                     (json.dumps(dg, ensure_ascii=False), dg["title"], status, keep, bs.now_iso(), actor, nid))
        bs._apply_derived(conn, nid, dg, review=status == "needs_review")
        bs._history(conn, nid, actor, "analyzed", dg)
        row = conn.execute("SELECT * FROM notices WHERE id = ?", (nid,)).fetchone()
    return bs.notice_json(row)


def pending_texts(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    return [{"id": r["id"], "receivedOn": r["received_on"], "text": r["original_text"]}
            for r in conn.execute("SELECT id, received_on, original_text FROM notices WHERE status = 'pending_analysis' AND deleted_at IS NULL AND original_text IS NOT NULL LIMIT 20")]


def resume(conn: sqlite3.Connection) -> None:
    st = get_state(conn)
    st.update({"paused": False, "failures": 0, "nextAllowedAt": None})
    _put_state(conn, st)


# ───── 예약 실행 ─────
def due_slot(times: List[str], now: datetime, last_slot: Optional[str]) -> Optional[str]:
    """지금 실행해야 할 예약 시각(YYYY-MM-DDTHH:MM). 이미 실행한 슬롯이거나 2시간 넘게 지난 슬롯은 건너뛴다."""
    k = now.astimezone(KST)
    today = k.date().isoformat()
    cur = k.strftime("%H:%M")
    passed = [t for t in sorted(times) if t <= cur]
    if not passed:
        return None
    slot = f"{today}T{passed[-1]}"
    h, m = map(int, passed[-1].split(":"))
    if (k.hour * 60 + k.minute) - (h * 60 + m) > 120:
        return None
    return None if last_slot and last_slot >= slot else slot


class SyncScheduler(threading.Thread):
    def __init__(self, db_path: Path, connect: Callable[[Path], sqlite3.Connection], adapter: NoticeSourceAdapter,
                 analyzer: Any, interval: float = 60.0):
        super().__init__(name="notice-sync", daemon=True)
        self.db_path, self.connect, self.adapter, self.analyzer, self.interval = db_path, connect, adapter, analyzer, interval
        self.stop_event = threading.Event()

    def tick(self, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
        now = now or datetime.now(timezone.utc)
        if not self.adapter.available():
            return None
        conn = self.connect(self.db_path)
        try:
            cfg = bs.get_settings(conn)["kidsnote"]
            if not cfg["enabled"]:
                return None
            st = get_state(conn)
            slot = due_slot(cfg["times"], now, st.get("lastSlot"))
            if not slot:
                return None
            st["lastSlot"] = slot
            _put_state(conn, st)
            return run_sync(conn, self.adapter, self.analyzer, "schedule", now)
        finally:
            conn.close()

    def run(self) -> None:  # pragma: no cover - 스레드 루프
        while not self.stop_event.wait(self.interval):
            try:
                self.tick()
            except Exception as e:
                print(f"[notice-sync] {type(e).__name__}", flush=True)
