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

from contact_numbers import (
    ContactNumberCandidate,
    classify_contact_number,
    extract_number_candidates,
    looks_like_contact_number,
    normalize_contact_number,
)

# ---------------- email ----------------

EMAIL_RE = re.compile(
    r"[\w.+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}",
    re.IGNORECASE,
)

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
    for m in re.finditer(r"(?:e[- ]?mail|邮箱|电子邮件)[^@\w]{0,20}([\w.+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,})",
                         text, re.IGNORECASE):
        labelled.append(m.group(1))
    for e in labelled:
        if e in cleaned:
            return e
    return cleaned[0]


# ---------------- phone / tel ----------------

def _pick_best_candidate(candidates: list[ContactNumberCandidate], kind: str) -> Optional[str]:
    for candidate in candidates:
        if candidate.kind == kind:
            return candidate.value
    return None


def extract_phone_numbers(html: str) -> dict[str, Optional[str]]:
    """同时提取手机号和固定电话。

    规则优先级是：
    1. `tel:` 链接和附近文案里的显式标签（mobile / office / 电话等）；
    2. 页面正文里的稳定号码格式；
    3. 如果只看到一个“像电话”的候选但分不清类型，默认把它当固定电话，
       避免把办公座机误塞进 `phone`。
    """
    soup = BeautifulSoup(html, "lxml")
    candidates: list[ContactNumberCandidate] = []
    seen: set[tuple[str, str]] = set()

    def add_candidate(raw: str, *, context: str = "", default_kind: Optional[str] = None) -> None:
        normalized = normalize_contact_number(raw)
        if not normalized:
            return
        kind = classify_contact_number(normalized, context=context, default_kind=default_kind)
        if kind is None:
            return
        key = (normalized, kind)
        if key in seen:
            return
        seen.add(key)
        score = 20 if context else 10
        if kind == "landline" and default_kind == "landline":
            score += 2
        candidates.append(ContactNumberCandidate(value=normalized, kind=kind, score=score))

    # `tel:` 常常是站点最干净的电话号码来源；这里把父节点文本也带上，
    # 便于利用 "Mobile"/"Office"/"电话" 这类标签做分类。
    for anchor in soup.find_all("a", href=True):
        href = anchor.get("href", "")
        if not isinstance(href, str) or not href.lower().startswith("tel:"):
            continue
        raw = href.split(":", 1)[1].strip()
        if not looks_like_contact_number(raw):
            continue
        context_parts = [
            anchor.get_text(" ", strip=True),
            anchor.parent.get_text(" ", strip=True) if anchor.parent else "",
        ]
        context = " ".join(part for part in context_parts if part)
        add_candidate(raw, context=context, default_kind="landline")

    text = soup.get_text(" ", strip=True)
    for candidate in extract_number_candidates(text, default_kind="landline"):
        key = (candidate.value, candidate.kind)
        if key in seen:
            continue
        seen.add(key)
        candidates.append(candidate)

    candidates.sort(key=lambda item: (-item.score, -len(item.value)))
    return {
        "phone": _pick_best_candidate(candidates, "mobile"),
        "tel": _pick_best_candidate(candidates, "landline"),
    }


def extract_phone(html: str) -> Optional[str]:
    return extract_phone_numbers(html).get("phone")


def extract_tel(html: str) -> Optional[str]:
    return extract_phone_numbers(html).get("tel")


# ---------------- avatar ----------------

AVATAR_KEYWORDS = ("avatar", "photo", "portrait", "headshot",
                   "touxiang", "zhaopian", "profile-pic", "person-photo",
                   "faculty-photo", "staff-photo")

SKIP_IMG_SUBSTR = (
    "logo", "icon", "banner", "bg-", "background", "placeholder",
    "qrcode", "footer", "header", "sprite", "loading", "default",
    "defult", "login",
    # Auth-wall / error chrome images — Scopus serves warning_small.gif as
    # the avatar of a preview-restricted author record.
    "warning", "no-photo", "noavatar", "no_avatar", "blank",
)

PROFILE_CONTAINER_RE = re.compile(
    r"(profile|faculty|person|teacher|staff|expert|scholar|member|people|team|导师|教师|专家)",
    re.I,
)
NAME_TOKEN_RE = re.compile(r"[a-z0-9]+")
GENERIC_NAME_TERMS = (
    # Indexing / aggregator product names — common <title> values on SPA-only pages
    "web of science",
    "clarivate",
    "scopus",
    "scopus preview",
    "researchgate",
    "orcid",
    "google scholar",
    # Auth walls and challenge pages — if these show up as a "name" the page is a wall
    "sign in",
    "sign up",
    "log in",
    "log on",
    "login",
    "preview",
    "just a moment",
    "attention required",
    "access denied",
    "forbidden",
    "not found",
    "page not found",
    # Form labels — when an auth-wall page's most prominent heading is a form field,
    # extract_name falls back to it; treat these as never-a-name signals.
    "email",
    "email address",
    "e-mail",
    "password",
    "username",
    "user name",
    "submit",
    "search",
    # Directory / chrome words
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
        # Hard veto on URLs whose filename clearly marks them as chrome / placeholders
        # (warning_small.gif, no-photo.png, logo.svg, etc.). These should never win
        # even if an auth-wall page labels them with alt="avatar".
        low_url = url.lower()
        if any(s in low_url for s in SKIP_IMG_SUBSTR):
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
    phones = extract_phone_numbers(html)
    return {
        "email": extract_email(html),
        "phone": phones.get("phone"),
        "tel": phones.get("tel"),
        "avatar": extract_avatar(html, base_url),
        "surname": extract_name(html),
        "country": country_from_tld(base_url),
    }
