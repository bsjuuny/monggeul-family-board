"""공지를 저장하기 전에 개인정보를 가린다.

키즈노트 답변(2026-11-24)처럼 공지·알림장에는 선생님·다른 아이·보호자 정보가 섞일 수 있다.
보드에 남기기 전에 서버에서 한 번 더 가린다(붙여넣기·공지톡 가져오기·수정·수집 모두 이 길로 지난다).

- 전화번호·이메일: 모양이 정해져 있어 자동으로 가린다(설정 maskContacts).
- 이름: 문장에서 사람 이름을 정확히 골라낼 수 없어, 보호자가 정한 '가릴 이름' 목록만 ○○로 바꾼다.
  '민준이가'처럼 이름 뒤에 붙는 말은 그대로 두어 '○○이가'로 읽힌다(공문에서 흔히 쓰는 표기).

가린 내용은 되돌릴 수 없다(원래 이름을 어디에도 남기지 않는다).
"""
from __future__ import annotations

import re
from typing import Any, Dict, List

NAME_MASK = "○○"
PHONE_MASK = "(연락처 가림)"
EMAIL_MASK = "(이메일 가림)"

# 010-1234-5678, 01012345678, 02)123-4567, 031.123.4567, +82 10-1234-5678
PHONE_RE = re.compile(r"(?<![\d])(?:\+82[\s.-]?)?0\d{1,2}[\s.)-]?\d{3,4}[\s.-]?\d{4}(?![\d])")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")

# 날짜·시각·분류처럼 사람 정보가 들어가지 않는 칸은 건드리지 않는다
SKIP_KEYS = {"schema", "date", "endDate", "time", "deadline", "eventDate", "eventEndDate", "eventTime",
             "dateConfidence", "confidence", "kind", "kinds", "for", "early", "needsReply"}

MAX_NAMES = 50
MAX_NAME_LEN = 20


def rules_from(settings: Dict[str, Any]) -> Dict[str, Any]:
    p = settings.get("privacy") or {}
    names = sorted({n for n in p.get("maskNames") or [] if isinstance(n, str) and n.strip()}, key=len, reverse=True)
    return {"contacts": p.get("maskContacts", True) is not False, "names": names}


def _names_re(names: List[str]) -> "re.Pattern[str] | None":
    if not names:
        return None
    # 긴 이름부터(‘김민준’이 ‘민준’보다 먼저) 바꾼다
    return re.compile("|".join(re.escape(n) for n in names))


def mask_text(text: Any, rules: Dict[str, Any]) -> Any:
    if not isinstance(text, str) or not text:
        return text
    out = text
    if rules.get("contacts"):
        out = EMAIL_RE.sub(EMAIL_MASK, out)
        out = PHONE_RE.sub(PHONE_MASK, out)
    pat = _names_re(rules.get("names") or [])
    if pat is not None:
        out = pat.sub(NAME_MASK, out)
    return out


def mask_value(v: Any, rules: Dict[str, Any], key: str = "") -> Any:
    if key in SKIP_KEYS:
        return v
    if isinstance(v, str):
        return mask_text(v, rules)
    if isinstance(v, list):
        return [mask_value(x, rules) for x in v]
    if isinstance(v, dict):
        return {k: mask_value(x, rules, k) for k, x in v.items()}
    return v


def mask_digest(dg: Dict[str, Any], rules: Dict[str, Any]) -> Dict[str, Any]:
    if not rules.get("contacts") and not rules.get("names"):
        return dg
    out = mask_value(dg, rules)
    if not str(out.get("title") or "").strip():
        out["title"] = dg.get("title") or "공지"
    return out


def active(rules: Dict[str, Any]) -> bool:
    return bool(rules.get("contacts") or rules.get("names"))
