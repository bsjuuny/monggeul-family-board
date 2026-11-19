#!/usr/bin/env python3
"""Playwright와 임시 태블릿 서버를 한 프로세스 수명주기로 실행한다.

Playwright의 ``webServer`` 종료는 Windows에서 자식 Python 프로세스를 남길 수 있다.
이 러너가 서버 스레드를 직접 열고 닫아 ``npm run e2e``가 항상 종료 코드를 돌려주게 한다.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402


PORT = 4173


def main() -> int:
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        db = Path(tmp) / "e2e.sqlite3"
        config = app.Config(
            db_path=db,
            dist_dir=app.DEFAULT_DIST_DIR,
            login_max_failures=1000,
            login_ip_max_failures=1000,
        )
        server = app.make_server(config, "127.0.0.1", PORT)
        app.create_user(db, "owner", "e2e-owner-pass", "owner")
        app.create_user(db, "mom", "e2e-mom-pass-1", "adult")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env = os.environ.copy()
        env["MGFB_E2E_EXTERNAL"] = "1"
        npx = "npx.cmd" if os.name == "nt" else "npx"
        try:
            return subprocess.run([npx, "playwright", "test"], env=env, check=False).returncode
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
