"""专家主页里的手机号 / 固话识别工具。

这个模块只做一件事：把页面文本里的电话候选先归一化，再尽量按
“mobile / landline” 做稳定分类。规则设计偏保守，宁可少识别，也避免把
办公电话误塞进手机字段，或者把手机号误当成固定电话。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, Optional


PhoneKind = Literal["mobile", "landline"]

MOBILE_CONTEXT_WORDS = (
    "mobile",
    "mob",
    "cell",
    "handphone",
    "手机",
    "手机号",
    "手机号码",
    "移动电话",
)
LANDLINE_CONTEXT_WORDS = (
    "tel",
    "telephone",
    "office",
    "office phone",
    "office tel",
    "contact number",
    "电话",
    "联系电话",
    "办公电话",
    "办公室",
    "座机",
    "固定电话",
)
FAX_CONTEXT_WORDS = ("fax", "facsimile", "传真")
PHONE_CANDIDATE_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:\+?\d[\d()\-\s]{5,}\d)(?:\s*(?:ext\.?|extension|x|转|分机)\s*\d{1,6})?(?![A-Za-z0-9])",
    re.IGNORECASE,
)

_CN_MOBILE_RE = re.compile(r"^(?:86)?1[3-9]\d{9}$")
_TW_MOBILE_RE = re.compile(r"^(?:886|0)?9\d{8}$")
_HK_MOBILE_RE = re.compile(r"^(?:852)?(?:5|6|9)\d{7}$")
_MO_MOBILE_RE = re.compile(r"^(?:853)?6\d{7}$")
_UAE_MOBILE_RE = re.compile(r"^(?:971|0)?5\d{8}$")
_MY_MOBILE_RE = re.compile(r"^(?:60|0)?1\d{8,9}$")
_SG_MOBILE_RE = re.compile(r"^(?:65)?[89]\d{7}$")
_JP_MOBILE_RE = re.compile(r"^(?:81|0)?(?:70|80|90)\d{8}$")
_KR_MOBILE_RE = re.compile(r"^(?:82|0)?10\d{8}$")

_CN_LANDLINE_RE = re.compile(r"^(?:86)?0\d{2,3}\d{7,8}(?:\d{1,6})?$")
_TW_LANDLINE_RE = re.compile(r"^(?:886|0)?[2-8]\d{7,8}$")
_HK_LANDLINE_RE = re.compile(r"^(?:852)?(?:2|3)\d{7}$")
_MO_LANDLINE_RE = re.compile(r"^(?:853)?(?:2|8)\d{7}$")
_UAE_LANDLINE_RE = re.compile(r"^(?:971|0)?[2-4679]\d{7}$")
_MY_LANDLINE_RE = re.compile(r"^(?:60|0)?[3-9]\d{7,8}$")
_SG_LANDLINE_RE = re.compile(r"^(?:65)?[36]\d{7}$")
_NANP_RE = re.compile(r"^(?:1)?[2-9]\d{2}[2-9]\d{6}$")

_NORMALIZE_STRIP_RE = re.compile(r"(?:\s*(?:ext\.?|extension|x|转|分机)\s*\d{1,6})$", re.IGNORECASE)
_PURE_RANGE_RE = re.compile(r"^\d{4,5}\s*[-–]\s*\d{4,5}(?:\s+\d{1,3})?$")
_YEAR_RANGE_RE = re.compile(r"^(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}$")


@dataclass(frozen=True)
class ContactNumberCandidate:
    value: str
    kind: PhoneKind
    score: int


def normalize_contact_number(raw: str) -> Optional[str]:
    """把电话号码统一清洗成稳定展示形态。

    这里不会强行改成纯数字，因为业务侧仍然希望保留 `+971 2 599 3238`、
    `021-55270127` 这种更可读的原格式；但会去掉分机尾巴和多余空白，方便后面
    做去重和分类。
    """
    if not isinstance(raw, str):
        return None
    cleaned = _NORMALIZE_STRIP_RE.sub("", raw)
    cleaned = re.sub(r"[;/|]+$", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,;；，、：:")
    digits = re.sub(r"\D", "", cleaned)
    if len(digits) < 7 or len(digits) > 15:
        return None
    return cleaned or None


def _compact_digits(raw: str) -> str:
    return re.sub(r"\D", "", raw)


def _looks_like_non_phone_range(normalized: str) -> bool:
    """过滤明显像年份区间、页码区间的数字片段。"""
    plain = normalized.strip()
    if _YEAR_RANGE_RE.fullmatch(plain):
        return True
    if _PURE_RANGE_RE.fullmatch(plain):
        return True

    groups = re.findall(r"\d+", plain)
    if len(groups) >= 2 and all(len(group) == 4 and group.startswith(("19", "20")) for group in groups[:2]):
        return True
    if len(groups) >= 2 and len(groups[0]) == len(groups[1]) >= 4 and not plain.startswith(("+", "0", "(")):
        return True
    return False


def _looks_like_embedded_code(text: str, start: int, end: int) -> bool:
    """过滤被字母数字包裹的编号片段。

    典型误判包括：
    - `DP190103660` 这种项目编号
    - 加密串里夹着的 `98022566`
    """
    prev_char = text[start - 1] if start > 0 else ""
    next_char = text[end] if end < len(text) else ""
    if prev_char.isalnum() or next_char.isalnum():
        return True

    left = text[max(0, start - 8) : start]
    right = text[end : min(len(text), end + 8)]
    around = f"{left}{text[start:end]}{right}"
    compact = re.sub(r"\s+", "", around)
    if re.fullmatch(r"[A-Fa-f0-9]{16,}", compact):
        return True
    return False


def _matches_mobile_pattern(digits: str) -> bool:
    return any(
        regex.fullmatch(digits)
        for regex in (
            _CN_MOBILE_RE,
            _TW_MOBILE_RE,
            _HK_MOBILE_RE,
            _MO_MOBILE_RE,
            _UAE_MOBILE_RE,
            _MY_MOBILE_RE,
            _SG_MOBILE_RE,
            _JP_MOBILE_RE,
            _KR_MOBILE_RE,
        )
    )


def _matches_landline_pattern(digits: str) -> bool:
    return any(
        regex.fullmatch(digits)
        for regex in (
            _CN_LANDLINE_RE,
            _TW_LANDLINE_RE,
            _HK_LANDLINE_RE,
            _MO_LANDLINE_RE,
            _UAE_LANDLINE_RE,
            _MY_LANDLINE_RE,
            _SG_LANDLINE_RE,
            _NANP_RE,
        )
    )


def classify_contact_number(
    raw: str,
    *,
    context: str = "",
    default_kind: Optional[PhoneKind] = None,
) -> Optional[PhoneKind]:
    """按上下文 + 号码格式把候选分类成手机或固定电话。"""
    normalized = normalize_contact_number(raw)
    if not normalized:
        return None
    if _looks_like_non_phone_range(normalized):
        return None

    context_lower = context.lower()
    if any(word in context_lower for word in FAX_CONTEXT_WORDS):
        return None
    mobile_pos = max((context_lower.rfind(word) for word in MOBILE_CONTEXT_WORDS if word in context_lower), default=-1)
    landline_pos = max((context_lower.rfind(word) for word in LANDLINE_CONTEXT_WORDS if word in context_lower), default=-1)
    if mobile_pos > landline_pos:
        return "mobile"
    if landline_pos > mobile_pos:
        return "landline"

    digits = _compact_digits(normalized)
    if _matches_mobile_pattern(digits):
        return "mobile"
    if _matches_landline_pattern(digits):
        return "landline"

    # 没有明显标签时，再用版式做最后兜底。专家主页里这类格式大多是办公座机。
    if re.search(r"\(\d{2,4}\)", normalized):
        return "landline"
    if re.search(r"\b0\d{2,3}[\s\-]\d{7,8}\b", normalized):
        return "landline"
    if normalized.startswith("+") and re.search(
        r"^\+\d{1,3}[\s\-]?\d{1,4}[\s\-]?\d{3,4}[\s\-]?\d{3,4}(?:[\s\-]?\d{1,4})?$",
        normalized,
    ):
        return "landline"

    return None


def looks_like_contact_number(raw: str) -> bool:
    return normalize_contact_number(raw) is not None


def _score_candidate(kind: PhoneKind, value: str, context: str) -> int:
    score = 0
    lower = context.lower()
    if kind == "mobile" and any(word in lower for word in MOBILE_CONTEXT_WORDS):
        score += 8
    if kind == "landline" and any(word in lower for word in LANDLINE_CONTEXT_WORDS):
        score += 8
    if value.startswith("+"):
        score += 2
    if kind == "landline" and any(token in value for token in ("-", "(", ")")):
        score += 2
    if kind == "mobile" and _matches_mobile_pattern(_compact_digits(value)):
        score += 2
    return score


def extract_number_candidates(text: str, *, default_kind: Optional[PhoneKind] = None) -> list[ContactNumberCandidate]:
    """从一段文本中提取所有可归类的电话号码候选。"""
    if not isinstance(text, str) or not text.strip():
        return []

    seen: set[tuple[str, PhoneKind]] = set()
    candidates: list[ContactNumberCandidate] = []
    for match in PHONE_CANDIDATE_RE.finditer(text):
        normalized = normalize_contact_number(match.group(0))
        if not normalized:
            continue
        if _looks_like_embedded_code(text, match.start(), match.end()):
            continue
        window = text[max(0, match.start() - 20) : match.end()]
        kind = classify_contact_number(normalized, context=window, default_kind=default_kind)
        if kind is None:
            continue
        key = (normalized, kind)
        if key in seen:
            continue
        seen.add(key)
        candidates.append(
            ContactNumberCandidate(
                value=normalized,
                kind=kind,
                score=_score_candidate(kind, normalized, window),
            )
        )

    candidates.sort(key=lambda item: (-item.score, -len(item.value)))
    return candidates
