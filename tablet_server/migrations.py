"""SQLite 스키마 마이그레이션 (v2).

원칙
  - schema_meta.schema_version 이 현재 버전이다. v1 DB(기존 운영 DB)는 1이다.
  - 올릴 버전이 있으면, 바꾸기 전에 DB 파일 전체를 sqlite backup API로 복사한다
    (<DB 폴더>/backups/pre-migrate-v{from}-to-v{to}-{시각}.sqlite3).
  - 각 마이그레이션은 하나의 트랜잭션(BEGIN IMMEDIATE)에서 실행한다. SQLite DDL은
    트랜잭션 안에서 되돌릴 수 있으므로, 실패하면 ROLLBACK 하고 DB는 손대기 전 상태로 남는다.
  - 기존 테이블·행은 지우거나 바꾸지 않는다(추가만 한다).
"""
from __future__ import annotations

import shutil
import sqlite3
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, List, Optional


class MigrationError(RuntimeError):
    def __init__(self, message: str, backup: Optional[Path] = None):
        super().__init__(message)
        self.backup = backup


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    apply: Callable[[sqlite3.Connection], None]


V2_SQL = """
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('tv')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at TEXT NOT NULL,
  last_seen_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS weather_cache (
  kind TEXT NOT NULL,
  grid TEXT NOT NULL,
  base TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (kind, grid)
);
CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('manual','gongjitalk','kidsnote','mock')),
  source_id TEXT,
  source_updated_at TEXT,
  content_hash TEXT NOT NULL,
  received_on TEXT NOT NULL,
  title TEXT NOT NULL,
  digest TEXT NOT NULL,
  original_text TEXT,
  status TEXT NOT NULL CHECK (status IN ('auto','needs_review','confirmed','dismissed','pending_analysis')),
  edited_by_user INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  confirmed_at TEXT,
  confirmed_by TEXT,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notices_source ON notices(source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_notices_hash ON notices(content_hash);
CREATE INDEX IF NOT EXISTS ix_notices_received ON notices(received_on);
CREATE TABLE IF NOT EXISTS notice_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  snapshot TEXT
);
CREATE INDEX IF NOT EXISTS ix_notice_history ON notice_history(notice_id);
CREATE TABLE IF NOT EXISTS prep_items (
  id TEXT PRIMARY KEY,
  item_key TEXT NOT NULL UNIQUE,
  notice_id TEXT,
  child_id TEXT,
  date TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('dropoff','pickup','event','document','parent_task')),
  text TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  user_edited INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  done_by TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_prep_date ON prep_items(date);
CREATE TABLE IF NOT EXISTS commute_exceptions (
  id TEXT PRIMARY KEY,
  item_key TEXT NOT NULL UNIQUE,
  notice_id TEXT,
  child_id TEXT,
  date TEXT NOT NULL,
  end_date TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('closed','dropoff_time','pickup_time')),
  time TEXT,
  note TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  user_edited INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_commute_exc_date ON commute_exceptions(date);
CREATE TABLE IF NOT EXISTS notice_events (
  id TEXT PRIMARY KEY,
  item_key TEXT NOT NULL UNIQUE,
  notice_id TEXT NOT NULL,
  date TEXT NOT NULL,
  end_date TEXT,
  time TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  calendar_event_id TEXT,
  calendar_snapshot TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notice_events_date ON notice_events(date);
CREATE TABLE IF NOT EXISTS pickups (
  date TEXT NOT NULL,
  child_id TEXT NOT NULL,
  assignee TEXT,
  done_at TEXT,
  done_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (date, child_id)
);
CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  fetched INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
"""


def _v2(conn: sqlite3.Connection) -> None:
    for stmt in [s.strip() for s in V2_SQL.split(";") if s.strip()]:
        conn.execute(stmt)


MIGRATIONS: List[Migration] = [
    Migration(2, "v2: TV 기기, 설정, 날씨 캐시, 공지·준비물·등하원 예외·픽업, 동기화", _v2),
]

LATEST_VERSION = max(m.version for m in MIGRATIONS)


def current_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM schema_meta WHERE key = 'schema_version'").fetchone()
    return int(row[0]) if row else 0


def pending(conn: sqlite3.Connection) -> List[Migration]:
    v = current_version(conn)
    return [m for m in MIGRATIONS if m.version > v]


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def backup_db(db_path: Path, dest: Path) -> Path:
    """온라인 백업: WAL에 있는 최신 내용까지 한 파일로 복사한다."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(str(db_path))
    try:
        out = sqlite3.connect(str(dest))
        try:
            src.backup(out)
        finally:
            out.close()
    finally:
        src.close()
    return dest


def migrate(db_path: Path, connect: Callable[[Path], sqlite3.Connection],
            log: Callable[[str], None] = lambda s: None, backup: bool = True) -> Optional[Path]:
    """필요한 마이그레이션을 적용한다. 적용했다면 사전 백업 경로를 돌려준다."""
    conn = connect(db_path)
    try:
        todo = pending(conn)
        if not todo:
            return None
        start = current_version(conn)
    finally:
        conn.close()
    backup_path: Optional[Path] = None
    if backup:
        backup_path = db_path.parent / "backups" / f"pre-migrate-v{start}-to-v{todo[-1].version}-{_stamp()}.sqlite3"
        backup_db(db_path, backup_path)
        log(f"마이그레이션 전 백업: {backup_path}")
    conn = connect(db_path)
    try:
        for m in todo:
            conn.execute("BEGIN IMMEDIATE")
            try:
                if current_version(conn) >= m.version:  # 다른 프로세스가 먼저 적용
                    conn.execute("ROLLBACK")
                    continue
                m.apply(conn)
                conn.execute("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'", (str(m.version),))
                conn.execute("COMMIT")
                log(f"스키마 v{m.version} 적용: {m.name}")
            except Exception as e:
                conn.execute("ROLLBACK")
                raise MigrationError(
                    f"스키마 v{m.version} 적용 실패({type(e).__name__}: {e}). DB는 바뀌지 않았어요."
                    + (f" 사전 백업: {backup_path}" if backup_path else ""),
                    backup_path,
                ) from e
    finally:
        conn.close()
    return backup_path


def dry_run(db_path: Path, connect: Callable[[Path], sqlite3.Connection]) -> List[str]:
    """운영 DB를 건드리지 않고 임시 사본에 마이그레이션을 적용해 본다."""
    lines: List[str] = []
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        copy = Path(tmp) / "dry-run.sqlite3"
        backup_db(db_path, copy)
        conn = connect(copy)
        try:
            before = current_version(conn)
            tables_before = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            counts_before = {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables_before}
        finally:
            conn.close()
        migrate(copy, connect, lines.append, backup=False)
        conn = connect(copy)
        try:
            after = current_version(conn)
            for t, n in sorted(counts_before.items()):
                m = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
                if m != n:
                    raise MigrationError(f"사본에서 기존 테이블 {t} 행 수가 바뀌었어요({n}→{m}).")
            new_tables = sorted({r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")} - tables_before)
            check = conn.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            conn.close()
        lines.append(f"스키마 v{before} → v{after}, 새 테이블 {len(new_tables)}개, 기존 테이블 행 수 변화 없음, integrity_check={check}")
    return lines


def restore_backup(backup: Path, db_path: Path) -> None:
    """서버가 꺼진 상태에서만 쓴다: 백업 파일로 DB를 되돌린다(현재 DB는 .before-restore 로 남긴다)."""
    if not backup.is_file():
        raise MigrationError(f"백업 파일이 없어요: {backup}")
    keep = db_path.with_name(db_path.name + f".before-restore-{_stamp()}")
    if db_path.exists():
        backup_db(db_path, keep)
    for suffix in ("-wal", "-shm"):
        side = db_path.with_name(db_path.name + suffix)
        if side.exists():
            side.unlink()
    shutil.copyfile(backup, db_path)
