"""공지를 저장하기 전에 개인정보를 가린다.

키즈노트 답변(2026-11-24)처럼 공지·알림장에는 선생님·다른 아이·보호자 정보가 섞일 수 있다.
보드에 남기기 전에 서버에서 한 번 더 가린다(붙여넣기·공지톡 가져오기·수정·수집 모두 이 길로 지난다).

- 전화번호·이메일: 모양이 정해져 있어 자동으로 가린다(설정 maskContacts).
- 이름: 보호자가 정한 '가릴 이름' 목록을 ○○로 바꾸고, '선생님·어머님' 같은 호칭 바로 앞의 이름도 가린다(maskHonorifics).
  호칭 없는 이름은 문장에서 정확히 골라낼 수 없어 목록에 넣어야 한다.
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

# 호칭 앞 이름: '김민준 어머님', '이지은 선생님', '하준 아버님' → '○○ 어머님' …
HONORIFICS = ("선생님", "원장님", "원감님", "교사", "쌤", "어머님", "어머니", "아버님", "아버지", "보호자님", "보호자", "할머님", "할아버님")
HONORIFIC_RE = re.compile(r"(?<![가-힣])([가-힣]{2,4})(\s?)(" + "|".join(HONORIFICS) + r")")
# 호칭 앞에 와도 사람 이름이 아닌 말(반 이름 '…반', 역할 '담임' 등)은 그대로 둔다
HONORIFIC_STOP = {
    "담임", "부담임", "보조", "보조교사", "모든", "우리", "각반", "각", "다른", "여러", "전체", "해당", "담당", "새", "새로운",
    "영어", "체육", "미술", "음악", "특활", "외부", "보건", "영양", "조리", "숲", "놀이", "교실", "오늘", "내일", "어제",
    "학부모", "어린이집", "유치원", "원", "반", "친구", "친구들", "아이", "아이들", "원아", "가정", "각가정", "모든가정",
    "선생님", "어머님", "아버님", "부모님", "부모", "보호자", "원장", "원감", "주임", "실장", "대표", "특수", "통합", "방과후",
}


def _honorific_sub(m: "re.Match[str]") -> str:
    word = m.group(1)
    # '고마운 선생님'·'우리반의 선생님'처럼 꾸미는 말(…는·…의·…운·…께)은 이름이 아니다
    if word in HONORIFIC_STOP or word.endswith(("반", "님", "들", "는", "의", "운", "께", "도", "만")):
        return m.group(0)
    return NAME_MASK + m.group(2) + m.group(3)


# 날짜·시각·분류처럼 사람 정보가 들어가지 않는 칸은 건드리지 않는다
SKIP_KEYS = {"schema", "date", "endDate", "time", "deadline", "eventDate", "eventEndDate", "eventTime",
             "dateConfidence", "confidence", "kind", "kinds", "for", "early", "needsReply"}

MAX_NAMES = 50
MAX_NAME_LEN = 20


def rules_from(settings: Dict[str, Any]) -> Dict[str, Any]:
    p = settings.get("privacy") or {}
    names = sorted({n for n in p.get("maskNames") or [] if isinstance(n, str) and n.strip()}, key=len, reverse=True)
    return {"contacts": p.get("maskContacts", True) is not False, "honorifics": p.get("maskHonorifics", True) is not False, "names": names}


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
    if rules.get("honorifics"):
        out = HONORIFIC_RE.sub(_honorific_sub, out)
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
    if not active(rules):
        return dg
    out = mask_value(dg, rules)
    if not str(out.get("title") or "").strip():
        out["title"] = dg.get("title") or "공지"
    return out


def active(rules: Dict[str, Any]) -> bool:
    return bool(rules.get("contacts") or rules.get("honorifics") or rules.get("names"))


def count_masks(before: Any, after: Any) -> int:
    """가린 곳 수(저장 뒤 '○곳을 가렸어요' 안내용)."""
    import json as _json
    a, b = _json.dumps(after, ensure_ascii=False), _json.dumps(before, ensure_ascii=False)
    return sum(max(0, a.count(t) - b.count(t)) for t in (NAME_MASK, PHONE_MASK, EMAIL_MASK))
