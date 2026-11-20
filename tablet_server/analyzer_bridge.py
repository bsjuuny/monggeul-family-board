"""서버에서 공지 분석기(TypeScript, dist-server/analyze.mjs)를 node 로 실행한다.

분석 규칙의 원본은 src/notices/ 의 TypeScript 하나뿐이다. 브라우저 입력 화면과 서버 자동 수집이
같은 코드를 쓰도록, 빌드(npm run build)가 dist-server/analyze.mjs 를 만든다.
node 가 없거나 번들이 없으면 AnalyzerUnavailable 을 올린다(호출자는 '분석 대기'로 저장한다).
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_BUNDLE = Path(__file__).resolve().parent.parent / "dist-server" / "analyze.mjs"


class AnalyzerUnavailable(RuntimeError):
    pass


def normalize_text(text: str) -> str:
    """TS normalizeForHash 와 같은 규칙: BOM 제거, 연속 공백 하나로, 앞뒤 공백 제거."""
    return re.sub(r"\s+", " ", text.replace("﻿", "")).strip()


def content_hash(text: str) -> str:
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()


class NodeAnalyzer:
    def __init__(self, bundle: Path = DEFAULT_BUNDLE, node: Optional[str] = None, timeout: float = 30.0):
        self.bundle = bundle
        self.node = node or shutil.which("node")
        self.timeout = timeout

    def available(self) -> bool:
        return bool(self.node) and self.bundle.is_file()

    def analyze(self, items: List[Dict[str, str]]) -> List[Dict[str, Any]]:
        """items: [{text, receivedOn}] → [{digest, contentHash}] (같은 순서)"""
        if not self.available():
            raise AnalyzerUnavailable("node 또는 dist-server/analyze.mjs 가 없어요. 'npm run build' 후 다시 시도하세요.")
        try:
            proc = subprocess.run([self.node, str(self.bundle)], input=json.dumps(items, ensure_ascii=False).encode("utf-8"),
                                  capture_output=True, timeout=self.timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise AnalyzerUnavailable(f"분석기 실행 실패({type(e).__name__})") from None
        if proc.returncode != 0:
            raise AnalyzerUnavailable(f"분석기 오류(exit {proc.returncode})")
        out = json.loads(proc.stdout.decode("utf-8"))
        if not isinstance(out, list) or len(out) != len(items):
            raise AnalyzerUnavailable("분석기 응답 형식이 올바르지 않아요.")
        return out
