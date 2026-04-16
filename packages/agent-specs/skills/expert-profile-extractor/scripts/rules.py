"""Deterministic regex / DOM extractors.

Only put a field here if its textual pattern is *stable across every site*.
Email and phone pass that bar. Avatar selection uses a ranked heuristic that
is deliberately conservative — a missing avatar is better than the wrong one.
"""
from __future__ import annotations

import re
from typing import Optional, List
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup


# ---------------- email ----------------

EMAIL_RE = re.compile(r"[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+", re.IGNORECASE)

EMAIL_BLOCKLIST_PREFIXES = (
    "noreply", "no-reply", "donotreply", "webmaster", "postmaster",
    "admin@", "info@", "support@", "contact@", "hello@",
)

def extract_email(html: str) -> Optional[str]:
    """Return the most profile-like email, or None.

    Strategy: collect all matches, drop obvious site-wide footer addresses,
    prefer the first one that appears near a 'email' / '邮箱' / '@' label.
    """
    candidates = EMAIL_RE.findall(html)
    cleaned = []
    for e in candidates:
        e = e.strip(".")
        low = e.lower()
        if any(low.startswith(p) for p in EMAIL_BLOCKLIST_PREFIXES):
            continue
        if low.endswith((".png", ".jpg", ".gif", ".svg", ".webp")):
            continue
        cleaned.append(e)
    if not cleaned:
        return None

    # Prefer emails that appear in the visible text near "email"/"邮箱"
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text(" ", strip=True)
    labelled = []
    for m in re.finditer(r"(?:e[- ]?mail|邮箱|电子邮件)[^@\w]{0,20}([\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+)",
                         text, re.IGNORECASE):
        labelled.append(m.group(1))
    for e in labelled:
        if e in cleaned:
            return e
    return cleaned[0]


# ---------------- phone ----------------

# Match patterns like:
#   +971 2 599 3238
#   021-55270127
#   (021) 5527-0127
#   +86 138 0000 0000
PHONE_RES = [
    re.compile(r"\+\d{1,3}[\s\-]?\d{1,4}[\s\-]?\d{3,4}[\s\-]?\d{3,4}(?:[\s\-]?\d{1,4})?"),
    re.compile(r"\b0\d{2,3}[\s\-]\d{7,8}\b"),                   # CN landline 021-xxxxxxxx
    re.compile(r"\b1[3-9]\d[\s\-]?\d{4}[\s\-]?\d{4}\b"),        # CN mobile
    re.compile(r"\(\d{2,4}\)\s?\d{3,4}[\s\-]?\d{4}"),            # (021) 5527-0127
]

PHONE_CONTEXT_WORDS = ("tel", "phone", "电话", "联系", "mobile", "office")


def extract_phone(html: str) -> Optional[str]:
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text(" ", strip=True)

    # Prefer phones that follow a context word
    for ctx in PHONE_CONTEXT_WORDS:
        m = re.search(ctx + r"[^\d+]{0,15}(" + "|".join(r.pattern for r in PHONE_RES) + ")",
                      text, re.IGNORECASE)
        if m:
            return re.sub(r"\s+", " ", m.group(1)).strip()

    for rx in PHONE_RES:
        m = rx.search(text)
        if m:
            return re.sub(r"\s+", " ", m.group(0)).strip()
    return None


# ---------------- avatar ----------------

AVATAR_KEYWORDS = ("avatar", "photo", "portrait", "headshot",
                   "touxiang", "zhaopian", "profile-pic", "person-photo",
                   "faculty-photo", "staff-photo")

SKIP_IMG_SUBSTR = (
    "logo", "icon", "banner", "bg-", "background", "placeholder",
    "qrcode", "footer", "header", "sprite", "loading", "default",
    "defult", "login",
)

PROFILE_CONTAINER_RE = re.compile(
    r"(profile|faculty|person|teacher|staff|expert|scholar|member|people|team|导师|教师|专家)",
    re.I,
)
NAME_TOKEN_RE = re.compile(r"[a-z0-9]+")
GENERIC_NAME_TERMS = (
    "web of science",
    "clarivate",
    "contact",
    "contact details",
    "staff contacts",
    "academic staff",
    "people",
    "faculty",
    "profile",
    "professor",
    "researcher",
    "expert",
    "teacher",
    "lecturer",
    "department",
    "college",
    "school",
    "university",
    "institute",
    "homepage",
    "home",
    "首页",
    "中文信息",
)


def _abs(src: str, base_url: str) -> str:
    if not src:
        return ""
    if src.startswith("data:"):
        return ""
    return urljoin(base_url, src)


def _pick_src(img) -> str:
    for attr in ("src", "data-src", "data-original", "data-lazy-src", "data-lazyload", "data-echo"):
        value = img.get(attr)
        if value:
            return value

    srcset = img.get("srcset") or img.get("data-srcset")
    if srcset:
        first = srcset.split(",")[0].strip().split(" ")[0].strip()
        if first:
            return first

    return ""


def _candidate_score(url: str, attrs_blob: str, *, page_name: str, in_profile_container: bool, in_main: bool) -> int:
    low_url = url.lower()
    score = 0

    if any(s in low_url for s in SKIP_IMG_SUBSTR):
        score -= 8

    if any(k in attrs_blob for k in AVATAR_KEYWORDS):
        score += 8

    if in_profile_container:
        score += 5
    if in_main:
        score += 2

    if any(k in low_url for k in ("faculty", "staff", "profile", "portrait", "headshot", "people")):
        score += 3

    if any(k in attrs_blob for k in ("thumbnail", "inner_image")):
        score -= 2

    if page_name:
        tokens = [t for t in NAME_TOKEN_RE.findall(page_name.lower()) if len(t) >= 2]
        matches = sum(1 for t in tokens if t in low_url or t in attrs_blob)
        score += matches * 3

    return score


def extract_avatar(html: str, base_url: str) -> Optional[str]:
    soup = BeautifulSoup(html, "lxml")
    page_name = extract_name(html) or ""
    best_url: Optional[str] = None
    best_score = -10_000

    def consider(src: str, attrs_blob: str, *, in_profile_container: bool, in_main: bool) -> None:
        nonlocal best_url, best_score
        url = _abs(src, base_url)
        if not url:
            return
        score = _candidate_score(
            url,
            attrs_blob.lower(),
            page_name=page_name,
            in_profile_container=in_profile_container,
            in_main=in_main,
        )
        if score > best_score:
            best_score = score
            best_url = url

    for meta in soup.find_all("meta"):
        prop = (meta.get("property") or meta.get("name") or "").lower()
        if prop in ("og:image", "og:image:secure_url", "twitter:image", "twitter:image:src"):
            consider(meta.get("content", ""), prop, in_profile_container=False, in_main=False)

    main = soup.find("main") or soup.find("article") or soup.body
    main_imgs = set(main.find_all("img")) if main else set()

    for img in soup.find_all("img"):
        attrs_blob = " ".join([
            " ".join(img.get("class", []) or []),
            img.get("id", "") or "",
            img.get("alt", "") or "",
            img.get("src", "") or "",
            img.get("data-src", "") or "",
            img.get("data-original", "") or "",
            img.get("data-lazy-src", "") or "",
            img.get("srcset", "") or "",
        ])
        parent = img.parent
        in_profile_container = False
        while parent is not None and getattr(parent, "name", None):
            parent_blob = " ".join([
                " ".join(parent.get("class", []) or []),
                parent.get("id", "") or "",
            ])
            if PROFILE_CONTAINER_RE.search(parent_blob):
                in_profile_container = True
                break
            parent = parent.parent
        consider(
            _pick_src(img),
            attrs_blob,
            in_profile_container=in_profile_container,
            in_main=img in main_imgs,
        )

    if best_score >= 0:
        return best_url
    return None


# ---------------- name ----------------

TITLE_SUFFIX_RES = [
    re.compile(r"\s*[-\|–—]\s*.*$"),  # "Name - University of X"
]


def _looks_like_person_name(candidate: str) -> bool:
    c = candidate.strip()
    if not c or len(c) > 80:
        return False

    low = c.lower()
    if any(term in low for term in GENERIC_NAME_TERMS):
        return False
    if re.search(r"\d", c):
        return False

    compact = re.sub(r"\s+", " ", c)
    if re.fullmatch(r"[\u4e00-\u9fff·]{2,8}", compact):
        return True

    tokens = [t for t in re.split(r"[\s,./]+", compact) if t]
    if 1 < len(tokens) <= 5 and all(re.fullmatch(r"[A-Za-z][A-Za-z'`\-]*", t) for t in tokens):
        return True

    return False


def extract_name(html: str) -> Optional[str]:
    soup = BeautifulSoup(html, "lxml")
    candidates: List[str] = []

    if soup.title and soup.title.string:
        t = soup.title.string.strip()
        for rx in TITLE_SUFFIX_RES:
            t = rx.sub("", t).strip()
        if t:
            candidates.append(t)

    h1 = soup.find("h1")
    if h1:
        candidates.append(h1.get_text(strip=True))

    # Return the shortest plausible (names are usually short)
    candidates = [c for c in candidates if c and _looks_like_person_name(c)]
    if not candidates:
        return None
    candidates.sort(key=len)
    return candidates[0]


# ---------------- country from TLD ----------------

TLD_TO_COUNTRY = {
    "cn": "中国", "hk": "中国香港", "tw": "中国台湾", "mo": "中国澳门",
    "jp": "日本", "kr": "韩国", "sg": "新加坡", "my": "马来西亚",
    "ae": "阿联酋", "sa": "沙特阿拉伯", "il": "以色列", "tr": "土耳其",
    "in": "印度", "pk": "巴基斯坦",
    "uk": "英国", "de": "德国", "fr": "法国", "it": "意大利", "es": "西班牙",
    "nl": "荷兰", "se": "瑞典", "ch": "瑞士", "at": "奥地利", "be": "比利时",
    "ru": "俄罗斯", "pl": "波兰", "ua": "乌克兰",
    "us": "美国", "ca": "加拿大", "mx": "墨西哥",
    "au": "澳大利亚", "nz": "新西兰",
    "br": "巴西", "ar": "阿根廷",
    "za": "南非", "eg": "埃及",
}


def country_from_tld(url: str) -> Optional[str]:
    host = urlparse(url).hostname or ""
    parts = host.lower().split(".")
    if len(parts) >= 2:
        # .edu.cn, .ac.uk — last two matter
        last = parts[-1]
        if last == "uk":
            return "英国"
        return TLD_TO_COUNTRY.get(last)
    return None


# ---------------- orchestration ----------------

def extract_all(html: str, base_url: str) -> dict:
    """Run every rule extractor. Returned dict may have None values."""
    return {
        "email": extract_email(html),
        "phone": extract_phone(html),
        "avatar": extract_avatar(html, base_url),
        "surname": extract_name(html),
        "country": country_from_tld(base_url),
    }
