"""Playwright e2e 전용: 임시 DB에 테스트 계정을 만들고 dist를 서빙한다.

실서비스에서는 쓰지 않는다(고정된 테스트 비밀번호). 운영 계정은 app.py --init-admin 으로 만든다.
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402

PORT = 4173

with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
    db = Path(tmp) / "e2e.sqlite3"
    config = app.Config(db_path=db, dist_dir=app.DEFAULT_DIST_DIR, login_max_failures=1000, login_ip_max_failures=1000)
    server = app.make_server(config, "127.0.0.1", PORT)
    app.create_user(db, "owner", "e2e-owner-pass", "owner")
    app.create_user(db, "mom", "e2e-mom-pass-1", "adult")
    print(f"e2e server on http://127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
