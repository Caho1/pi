"""OpenCLI-style HTML cleaner for expert profile pages.

Single cleaner used by the extraction pipeline: extract main content,
collect structured prefill candidates, drop navigation/boilerplate.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from copy import deepcopy
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Optional
from urllib.parse import urlparse

from bs4 import BeautifulSoup, Tag

MAX_CHARS = 20000

NOISE_TAGS = (
    "script",
    "style",
    "noscript",
    "svg",
    "iframe",
    "canvas",
    "header",
    "footer",
    "nav",
    "aside",
    "form",
    "button",
)

NOISE_SELECTORS = (
    ".breadcrumb",
    ".breadcrumbs",
    ".breadcrumbs-container",
    ".menu",
    ".sidebar",
    ".footer",
    ".header",
    ".nav",
    ".navbar",
    ".nav-tabs",
    ".navigation",
    ".share",
    ".social",
    ".comment",
    ".comments",
    ".cookie",
    ".banner",
    ".advertisement",
    ".ads",
    ".related",
    ".left-bar",
    ".right-bar",
    ".more-options-container",
    ".accordion-content",
    "[role=navigation]",
    "[role=banner]",
    "[role=contentinfo]",
    "#header",
    "#footer",
    "#nav",
    "#sidebar",
    "#menu",
    "#treeview",
)

POSITIVE_HINTS = (
    "content",
    "article",
    "post",
    "entry",
    "body",
    "main",
    "detail",
    "profile",
    "faculty",
    "teacher",
    "expert",
    "bio",
    "intro",
    "introduction",
    "resume",
    "person",
    "staff",
)

NEGATIVE_HINTS = (
    "nav",
    "menu",
    "header",
    "footer",
    "side",
    "breadcrumb",
    "comment",
    "share",
    "social",
    "ads",
    "advert",
    "search",
    "tool",
    "login",
)

META_TITLE_SELECTORS = (
    ('meta', {"property": "og:title"}),
    ('meta', {"name": "title"}),
    ('meta', {"property": "twitter:title"}),
)

META_AUTHOR_SELECTORS = (
    ('meta', {"name": "author"}),
    ('meta', {"property": "article:author"}),
    ('meta', {"name": "twitter:creator"}),
)

META_TIME_SELECTORS = (
    ('meta', {"property": "article:published_time"}),
    ('meta', {"name": "date"}),
    ('meta', {"name": "publishdate"}),
)

ACADEMIC_TITLE_PATTERNS = (
    (re.compile(r"\bchair professor\b", re.I), "讲席教授"),
    (re.compile(r"\bdistinguished professor\b", re.I), "杰出教授"),
    (re.compile(r"\bprofessor emeritus\b", re.I), "荣休教授"),
    (re.compile(r"\bresearch professor\b", re.I), "研究教授"),
    (re.compile(r"\bassociate professor\b", re.I), "副教授"),
    (re.compile(r"\bassistant professor\b", re.I), "助理教授"),
    (re.compile(r"\bsenior lecturer\b", re.I), "高级讲师"),
    (re.compile(r"\blecturer\b", re.I), "讲师"),
    (re.compile(r"\bprofessor\b", re.I), "教授"),
    (re.compile(r"特聘教授"), "特聘教授"),
    (re.compile(r"讲席教授"), "讲席教授"),
    (re.compile(r"荣休教授"), "荣休教授"),
    (re.compile(r"副教授"), "副教授"),
    (re.compile(r"助理教授"), "助理教授"),
    (re.compile(r"教授"), "教授"),
    (re.compile(r"讲师"), "讲师"),
    (re.compile(r"副研究员"), "副研究员"),
    (re.compile(r"研究员"), "研究员"),
)

ADMIN_TITLE_PATTERNS = (
    (re.compile(r"\bvice dean\b", re.I), "副院长"),
    (re.compile(r"\bdean\b", re.I), "院长"),
    (re.compile(r"\bdepartment chair\b", re.I), "系主任"),
    (re.compile(r"\bchair of\b", re.I), "系主任"),
    (re.compile(r"\bdirector\b", re.I), "主任"),
    (re.compile(r"\bhead of\b", re.I), "负责人"),
    (re.compile(r"\bcoordinator\b", re.I), "协调人"),
    (re.compile(r"\bprogramme leader\b", re.I), "项目负责人"),
    (re.compile(r"\bprogram leader\b", re.I), "项目负责人"),
    (re.compile(r"博士生导师"), "博士生导师"),
    (re.compile(r"硕士生导师"), "硕士生导师"),
    (re.compile(r"副院长"), "副院长"),
    (re.compile(r"院长"), "院长"),
    (re.compile(r"系主任"), "系主任"),
    (re.compile(r"副主任"), "副主任"),
    (re.compile(r"主任"), "主任"),
    (re.compile(r"副所长"), "副所长"),
    (re.compile(r"所长"), "所长"),
)

RESEARCH_LABEL_RE = re.compile(
    r"^(?:research interests?|research areas?|current research|my expertise|primary interest|fields of research|"
    r"research summary|research focus|research topics|研究方向|研究领域|研究兴趣|主要研究方向|研究专长|研究内容)"
    r"\s*[:：]?\s*(.*)$",
    re.I,
)

BIO_LABEL_RE = re.compile(r"^(?:biography|bio|简介|个人简介|基本信息)\s*[:：]?\s*$", re.I)

BACKUP_CONTACT_RE = re.compile(
    r"(orcid|google scholar|researchgate|scopus|dblp|homepage|home page|personal website|staff website|"
    r"办公地点|地址|location|office|address|webpage|website|个人主页|教师主页|主页)",
    re.I,
)

AFFILIATION_SKIP_RE = re.compile(
    r"(received|graduated|fellow|award|citation|publication|paper|journal|conference|"
    r"google scholar|orcid|scopus|biography|research activity|member|ieee|acm|aimbe|"
    r"获得|入选|论文|期刊|会议|引用)",
    re.I,
)


@dataclass
class ExtractionResult:
    """保存提取调试信息，便于比较新旧 cleaner 的实际效果。"""

    title: str
    author: str
    publish_time: str
    strategy: str
    selector_hint: str
    text_length: int
    text: str


def _normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _strip_site_suffix(title: str) -> str:
    return re.sub(r"\s*[|\-–—]\s*[^|\-–—]{1,30}$", "", title or "").strip()


def _tag_descriptor(tag: Optional[Tag]) -> str:
    if tag is None:
        return ""
    parts = [tag.name]
    if tag.get("id"):
        parts.append(f"#{tag['id']}")
    class_names = [cls for cls in tag.get("class", []) if cls]
    if class_names:
        parts.append("." + ".".join(class_names[:3]))
    return "".join(parts)


def _find_meta_content(soup: BeautifulSoup, selectors: Iterable[tuple[str, dict[str, str]]]) -> str:
    for name, attrs in selectors:
        node = soup.find(name, attrs=attrs)
        if not node:
            continue
        value = node.get("content") or node.get_text(" ", strip=True)
        value = _normalize_space(value)
        if value:
            return value
    return ""


def _extract_metadata(soup: BeautifulSoup) -> tuple[str, str, str]:
    """先抽标题/作者/时间，后续即便正文容器选偏也能把关键信息带给 LLM。"""

    title = _strip_site_suffix(_find_meta_content(soup, META_TITLE_SELECTORS))
    if not title and soup.title:
        title = _strip_site_suffix(_normalize_space(soup.title.get_text(" ", strip=True)))
    if not title:
        h1 = soup.find("h1")
        title = _normalize_space(h1.get_text(" ", strip=True)) if h1 else ""

    author = _find_meta_content(soup, META_AUTHOR_SELECTORS)

    publish_time = _find_meta_content(soup, META_TIME_SELECTORS)
    if not publish_time:
        time_node = soup.find("time")
        if time_node:
            publish_time = _normalize_space(time_node.get("datetime") or time_node.get_text(" ", strip=True))

    return title, author, publish_time


def _remove_noise(root: Tag) -> None:
    """在候选正文节点内部删掉高噪声块，尽量贴近 OpenCLI 的"先 clone 再清洗"思路。"""

    for tag_name in NOISE_TAGS:
        for node in root.find_all(tag_name):
            node.decompose()

    for selector in NOISE_SELECTORS:
        try:
            for node in root.select(selector):
                node.decompose()
        except Exception:
            continue


def _text_length(tag: Tag) -> int:
    return len(_normalize_space(tag.get_text(" ", strip=True)))


def _keyword_bonus(tag: Tag) -> int:
    joined = " ".join(
        part.lower()
        for part in (
            tag.get("id", ""),
            " ".join(tag.get("class", [])),
            tag.get("role", ""),
            tag.get("aria-label", ""),
        )
        if part
    )
    bonus = 0
    for hint in POSITIVE_HINTS:
        if hint in joined:
            bonus += 180
    for hint in NEGATIVE_HINTS:
        if hint in joined:
            bonus -= 220
    return bonus


def _paragraph_bonus(tag: Tag) -> int:
    blocks = 0
    for node in tag.find_all(["p", "li", "dd", "dt", "td"]):
        if len(_normalize_space(node.get_text(" ", strip=True))) >= 18:
            blocks += 1
    return min(blocks, 25) * 70


def _heading_bonus(tag: Tag) -> int:
    headings = 0
    for node in tag.find_all(["h1", "h2", "h3", "strong", "b"]):
        if len(_normalize_space(node.get_text(" ", strip=True))) >= 4:
            headings += 1
    return min(headings, 10) * 35


def _link_penalty(tag: Tag, text_len: int) -> int:
    if text_len <= 0:
        return 0
    link_text = " ".join(_normalize_space(a.get_text(" ", strip=True)) for a in tag.find_all("a"))
    link_len = len(_normalize_space(link_text))
    density = link_len / max(text_len, 1)
    # 导航型容器的文本长度往往也不小，但链接文本占比会明显更高；
    # 这里同时惩罚"绝对链接文本量"和"链接密度"，避免大导航块压过正文块。
    return int(link_len * 1.8 + density * 600)


def _score_candidate(tag: Tag) -> int:
    """给候选节点打分时，优先保留"文本密集且像正文"的区域，而不是最长的导航块。"""

    text_len = _text_length(tag)
    if text_len < 80:
        return -10_000

    score = text_len
    score += _keyword_bonus(tag)
    score += _paragraph_bonus(tag)
    score += _heading_bonus(tag)
    score -= _link_penalty(tag, text_len)

    # 过深且纯 div 嵌套的块经常是布局容器，略微降权。
    if tag.name == "div" and len(tag.find_all("div", recursive=False)) >= 6:
        score -= 120

    return score


def _pick_best(candidates: Iterable[Tag]) -> Optional[Tag]:
    best_tag: Optional[Tag] = None
    best_score = -10_000
    for tag in candidates:
        score = _score_candidate(tag)
        if score > best_score:
            best_score = score
            best_tag = tag
    return best_tag


def _narrow_container(container: Tag) -> Tag:
    """如果当前块明显偏大，尝试向下收缩到分数接近但更聚焦的子容器。"""

    current = container
    for _ in range(3):
        parent_score = _score_candidate(current)
        parent_len = _text_length(current)
        descendants = [
            node
            for node in current.find_all(["article", "main", "section", "div"])
            if node is not current
        ]
        best_child: Optional[Tag] = None
        best_child_score = -10_000

        for node in descendants:
            node_len = _text_length(node)
            if node_len < 150:
                continue
            if node_len < parent_len * 0.35:
                continue
            if node_len > parent_len * 0.98:
                continue

            score = _score_candidate(node)
            if score > best_child_score:
                best_child = node
                best_child_score = score

        if best_child is None:
            break

        if best_child_score >= parent_score - 150:
            current = best_child
            continue

        break

    return current


def _select_main_container(soup: BeautifulSoup) -> tuple[Optional[Tag], str]:
    """按 OpenCLI 的优先级选主容器：语义标签优先，不够时退化到文本密集块。"""

    articles = soup.find_all("article")
    if len(articles) == 1:
        return articles[0], "article"
    if len(articles) > 1:
        best_article = _pick_best(articles)
        if best_article is not None:
            return best_article, "article-largest"

    role_main = soup.select_one('[role="main"]')
    if role_main is not None:
        return role_main, "role-main"

    main_tag = soup.find("main")
    if main_tag is not None:
        return main_tag, "main"

    dense_candidates = soup.find_all(
        lambda node: isinstance(node, Tag)
        and node.name in {"div", "section", "article"}
        and (
            any(hint in (node.get("id", "") + " " + " ".join(node.get("class", []))).lower() for hint in POSITIVE_HINTS)
            or _text_length(node) >= 250
        )
    )
    best_dense = _pick_best(dense_candidates)
    if best_dense is not None:
        return _narrow_container(best_dense), "dense-candidate"

    body = soup.body or soup
    return body, "body"


def _iter_text_blocks(root: Tag) -> list[str]:
    """尽量按块拿文本，减少 `get_text()` 一把梭带来的菜单/按钮串行粘连问题。"""

    preferred = root.find_all(["h1", "h2", "h3", "h4", "p", "li", "dd", "dt", "td", "th", "figcaption"])
    if preferred:
        card_blocks: list[str] = []
        blocks: list[str] = []
        preferred_names = {"h1", "h2", "h3", "h4", "p", "li", "dd", "dt", "td", "th", "figcaption"}
        for node in preferred:
            # 只保留更"叶子化"的块，避免同一段文字同时被 td 和 p 各取一次。
            if node.find(lambda child: isinstance(child, Tag) and child.name in preferred_names):
                continue
            blocks.append(_normalize_space(node.get_text(" ", strip=True)))

        # 很多教师主页把"姓名/电话/邮箱"放在短小的 div 卡片里，而不是 p/li。
        # 这里补充收集明显像个人信息的叶子 div，避免把名片区丢掉。
        for node in root.find_all("div"):
            if node.find(["div", "section", "article", "main", "p", "li", "dd", "dt", "td", "th", "figcaption"]):
                continue
            text = _normalize_space(node.get_text(" ", strip=True))
            if len(text) < 4 or len(text) > 220:
                continue

            joined = " ".join(
                part.lower()
                for part in (node.get("id", ""), " ".join(node.get("class", [])))
                if part
            )
            looks_like_profile_card = any(
                hint in joined
                for hint in ("title", "text", "info", "contact", "profile", "name", "carrer", "job", "position")
            )
            looks_like_contact_line = bool(
                re.search(
                    r"(姓名|电话|邮箱|mail|email|office|location|faculty|professor|department|school|college|"
                    r"institute|laboratory|学院|系|研究所|实验室|研究方向|主页|网址|@)",
                    text,
                    re.I,
                )
            )
            if looks_like_profile_card or looks_like_contact_line:
                card_blocks.append(text)

        combined = card_blocks + blocks
        if combined:
            return combined

    return [_normalize_space(line) for line in root.get_text("\n", strip=True).splitlines()]


def _deduplicate_lines(lines: Iterable[str]) -> list[str]:
    """只去掉明显重复的长文本，避免把"电话/邮箱"这种短字段误删。"""

    result: list[str] = []
    seen_long: set[str] = set()
    previous_key = ""

    for line in lines:
        normalized = _normalize_space(line)
        if not normalized:
            continue

        key = re.sub(r"\s+", "", normalized)
        if key == previous_key:
            continue

        if len(key) >= 20:
            if key in seen_long:
                continue
            seen_long.add(key)

        result.append(normalized)
        previous_key = key

    return result


def _build_output_text(title: str, author: str, publish_time: str, lines: list[str]) -> str:
    """把 metadata 作为头部一起输出，模拟 OpenCLI 下载器会补 frontmatter 的做法。"""

    header_lines: list[str] = []
    if title:
        header_lines.append(f"标题: {title}")
    if author:
        header_lines.append(f"作者: {author}")
    if publish_time:
        header_lines.append(f"发布时间: {publish_time}")

    body_lines = lines
    if header_lines and body_lines:
        return ("\n".join(header_lines) + "\n\n" + "\n".join(body_lines))[:MAX_CHARS]
    if header_lines:
        return "\n".join(header_lines)[:MAX_CHARS]
    return "\n".join(body_lines)[:MAX_CHARS]


def _flatten_jsonld_nodes(payload: Any) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    if isinstance(payload, dict):
        nodes.append(payload)
        for key in ("@graph", "itemListElement", "author", "members"):
            value = payload.get(key)
            if isinstance(value, list):
                for item in value:
                    nodes.extend(_flatten_jsonld_nodes(item))
            elif isinstance(value, dict):
                nodes.extend(_flatten_jsonld_nodes(value))
    elif isinstance(payload, list):
        for item in payload:
            nodes.extend(_flatten_jsonld_nodes(item))
    return nodes


def _collect_structured_lines_from_person(node: dict[str, Any]) -> list[str]:
    """从结构化数据中只抽对专家画像最有价值的字段，避免把整页 publication 都灌进来。"""

    lines: list[str] = []

    def add(label: str, value: Any) -> None:
        if isinstance(value, list):
            cleaned_items = [_normalize_space(str(item)) for item in value if _normalize_space(str(item))]
            if cleaned_items:
                lines.append(f"{label}: {'; '.join(cleaned_items)}")
            return
        cleaned = _normalize_space(str(value)) if value is not None else ""
        if cleaned:
            lines.append(f"{label}: {cleaned}")

    name = node.get("name")
    if not name and node.get("givenName") and node.get("familyName"):
        name = f"{node.get('givenName')} {node.get('familyName')}"
    add("姓名", name)
    add("职称", node.get("jobTitle") or node.get("title"))

    works_for = node.get("worksFor")
    if isinstance(works_for, dict):
        add("机构", works_for.get("name"))

    add("邮箱", node.get("email"))
    add("电话", node.get("telephone"))
    add("研究方向", node.get("knowsAbout"))
    add("简介", node.get("description"))

    return lines


def _extract_jsonld_lines(soup: BeautifulSoup) -> list[str]:
    for script in soup.find_all("script", attrs={"type": re.compile(r"ld\+json", re.I)}):
        raw = (script.string or script.get_text() or "").strip()
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue

        for node in _flatten_jsonld_nodes(payload):
            node_type = node.get("@type")
            types = node_type if isinstance(node_type, list) else [node_type]
            normalized_types = {str(item).lower() for item in types if item}
            if "person" in normalized_types:
                lines = _collect_structured_lines_from_person(node)
                if lines:
                    return lines
    return []


def _extract_window_data_lines(soup: BeautifulSoup) -> list[str]:
    for script in soup.find_all("script"):
        raw = script.string or script.get_text() or ""
        marker = "window.__DATA__="
        if marker not in raw:
            continue

        candidate = raw.split(marker, 1)[1].strip()
        if candidate.endswith(";"):
            candidate = candidate[:-1]
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue

        components = payload.get("components") if isinstance(payload, dict) else None
        if not isinstance(components, list):
            continue

        for component in components:
            if not isinstance(component, dict):
                continue
            profile = component.get("profile")
            if not isinstance(profile, dict):
                continue

            lines = _collect_structured_lines_from_person(profile)
            if isinstance(profile.get("campus"), str) or isinstance(profile.get("building_name"), str):
                location = " ".join(
                    part for part in [
                        _normalize_space(profile.get("campus", "")),
                        _normalize_space(profile.get("building_name", "")),
                        _normalize_space(profile.get("room_number", "")),
                    ]
                    if part
                )
                if location:
                    lines.append(f"地点: {location}")
            if lines:
                return lines
    return []


def _extract_structured_lines(soup: BeautifulSoup) -> list[str]:
    lines = _extract_jsonld_lines(soup)
    if lines:
        return _deduplicate_lines(lines)

    lines = _extract_window_data_lines(soup)
    if lines:
        return _deduplicate_lines(lines)

    return []


def _extract_dom_lines(soup: BeautifulSoup) -> list[str]:
    """只从主容器 DOM 提取行块，不触发 structured fallback，方便 prefill 同时看到两种证据。

    注意：此函数会对传入的 soup 做 deepcopy 再清洗，不会修改原始 soup。
    """

    container, _ = _select_main_container(soup)
    if container is None:
        return []

    cleaned_root = deepcopy(container)
    _remove_noise(cleaned_root)
    return _deduplicate_lines(_iter_text_blocks(cleaned_root))


def _deduplicate_items(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        cleaned = _normalize_space(value)
        if not cleaned:
            continue
        key = cleaned.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(cleaned)
    return result


def _content_lines_from_text(text: str) -> list[str]:
    """把 cleaner 输出重新切回语义行，后续的 prefill 规则都基于这组行工作。"""

    lines: list[str] = []
    for raw in text.splitlines():
        cleaned = _normalize_space(raw)
        if not cleaned:
            continue
        if cleaned.startswith(("标题:", "作者:", "发布时间:")):
            continue
        lines.append(cleaned)
    return lines


def _match_title_value(text: str, patterns: Iterable[tuple[re.Pattern[str], str]]) -> Optional[str]:
    for pattern, replacement in patterns:
        if pattern.search(text):
            return replacement
    return None


def _split_semantic_items(text: str) -> list[str]:
    """把研究方向等条目型文本切成数组，但尽量避免把完整段落切碎。"""

    normalized = _normalize_space(text)
    if not normalized:
        return []

    normalized = re.sub(r"^\d+[\.\)]\s*", "", normalized)
    if len(normalized) > 120 and not re.search(r"[;；|、]", normalized):
        return [normalized]

    parts = re.split(r"[;；|、]|,(?=\s*[A-Z\u4e00-\u9fff])|，", normalized)
    return _deduplicate_items(parts)


def _is_short_heading(line: str) -> bool:
    normalized = _normalize_space(line)
    if not normalized:
        return False
    if len(normalized) <= 24 and not re.search(r"[。.!?；;:：]", normalized):
        return True
    return False


def _collect_following_block(lines: list[str], start_index: int, limit: int = 8) -> list[str]:
    values: list[str] = []
    for next_line in lines[start_index + 1:start_index + 1 + limit]:
        if not next_line:
            continue
        if BIO_LABEL_RE.match(next_line) or RESEARCH_LABEL_RE.match(next_line):
            break
        if _is_short_heading(next_line) and values:
            break
        values.append(next_line)
    return values


def _looks_like_person_name_candidate(text: str) -> bool:
    normalized = _normalize_space(text)
    if not normalized or len(normalized) > 80:
        return False
    if AFFILIATION_SKIP_RE.search(normalized):
        return False
    if re.search(r"\d", normalized):
        return False
    if normalized in {"Academic Staff", "People", "中文信息"}:
        return False

    if re.fullmatch(r"[\u4e00-\u9fff·]{2,8}", normalized):
        return True

    tokens = [token for token in re.split(r"[\s,./]+", normalized) if token]
    return 1 < len(tokens) <= 6 and all(re.fullmatch(r"[A-Za-z][A-Za-z'`\-]*", token) for token in tokens)


def _extract_structured_prefill(soup: BeautifulSoup) -> dict[str, Any]:
    """优先吃 JSON-LD / 注水脚本里的 Person 数据，这部分证据最强、站点差异也最小。"""

    best_profile: dict[str, Any] = {}
    best_score = -1

    def score_profile(profile: dict[str, Any]) -> int:
        score = 0
        for key in ("name", "institution", "academic_title", "bio", "research_areas", "contact"):
            value = profile.get(key)
            if isinstance(value, list) and value:
                score += 2
            elif value:
                score += 2
        return score

    def consider(profile: dict[str, Any]) -> None:
        nonlocal best_profile, best_score
        score = score_profile(profile)
        if score > best_score:
            best_profile = profile
            best_score = score

    for script in soup.find_all("script", attrs={"type": re.compile(r"ld\+json", re.I)}):
        raw = (script.string or script.get_text() or "").strip()
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue

        for node in _flatten_jsonld_nodes(payload):
            node_type = node.get("@type")
            types = node_type if isinstance(node_type, list) else [node_type]
            normalized_types = {str(item).lower() for item in types if item}
            if "person" not in normalized_types:
                continue

            profile: dict[str, Any] = {}
            name = node.get("name")
            if not name and node.get("givenName") and node.get("familyName"):
                name = f"{node.get('givenName')} {node.get('familyName')}"
            if name:
                profile["name"] = _normalize_space(str(name))

            works_for = node.get("worksFor") or node.get("affiliation")
            if isinstance(works_for, dict) and works_for.get("name"):
                profile["institution"] = _normalize_space(str(works_for.get("name")))
            elif isinstance(works_for, list):
                names = [
                    _normalize_space(str(item.get("name")))
                    for item in works_for
                    if isinstance(item, dict) and item.get("name")
                ]
                if names:
                    profile["institution"] = names[0]

            job_title = node.get("jobTitle") or node.get("title")
            if job_title:
                mapped = _match_title_value(str(job_title), ACADEMIC_TITLE_PATTERNS)
                profile["academic_title"] = mapped or _normalize_space(str(job_title))

            description = node.get("description")
            if description:
                profile["bio"] = _normalize_space(str(description))[:300]

            knows_about = node.get("knowsAbout")
            if isinstance(knows_about, list):
                profile["research_areas"] = _deduplicate_items(str(item) for item in knows_about)
            elif isinstance(knows_about, str):
                profile["research_areas"] = _split_semantic_items(knows_about)

            same_as = node.get("sameAs")
            if isinstance(same_as, list):
                contact_items = [str(item) for item in same_as if isinstance(item, str)]
                if contact_items:
                    profile["contact"] = "; ".join(_deduplicate_items(contact_items[:4]))

            consider(profile)

    for script in soup.find_all("script"):
        raw = script.string or script.get_text() or ""
        marker = "window.__DATA__="
        if marker not in raw:
            continue
        candidate = raw.split(marker, 1)[1].strip()
        if candidate.endswith(";"):
            candidate = candidate[:-1]
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue

        components = payload.get("components") if isinstance(payload, dict) else None
        if not isinstance(components, list):
            continue

        for component in components:
            if not isinstance(component, dict):
                continue
            profile_node = component.get("profile")
            if not isinstance(profile_node, dict):
                continue

            profile: dict[str, Any] = {}
            name = profile_node.get("preferred_name") or profile_node.get("name")
            if not name and profile_node.get("first_name") and profile_node.get("last_name"):
                name = f"{profile_node.get('first_name')} {profile_node.get('last_name')}"
            if name:
                profile["name"] = _normalize_space(str(name))

            for institution_key in ("institution", "organisation_name", "organization_name", "employer"):
                if profile_node.get(institution_key):
                    profile["institution"] = _normalize_space(str(profile_node.get(institution_key)))
                    break

            for dept_key in ("department", "department_name", "school", "faculty", "college", "unit"):
                if profile_node.get(dept_key):
                    profile["college_department"] = _normalize_space(str(profile_node.get(dept_key)))
                    break

            if profile_node.get("title"):
                mapped = _match_title_value(str(profile_node.get("title")), ACADEMIC_TITLE_PATTERNS)
                profile["academic_title"] = mapped or _normalize_space(str(profile_node.get("title")))

            for bio_key in ("bio", "biography", "summary"):
                if profile_node.get(bio_key):
                    profile["bio"] = _normalize_space(str(profile_node.get(bio_key)))[:300]
                    break

            for areas_key in ("research_interests", "research_areas", "keywords"):
                value = profile_node.get(areas_key)
                if isinstance(value, list):
                    profile["research_areas"] = _deduplicate_items(str(item) for item in value)
                    break
                if isinstance(value, str) and value.strip():
                    profile["research_areas"] = _split_semantic_items(value)
                    break

            contact_items: list[str] = []
            location = " ".join(
                part
                for part in [
                    _normalize_space(str(profile_node.get("campus", ""))),
                    _normalize_space(str(profile_node.get("building_name", ""))),
                    _normalize_space(str(profile_node.get("room_number", ""))),
                ]
                if part
            )
            if location:
                contact_items.append(f"地点: {location}")
            if profile_node.get("homepage"):
                contact_items.append(str(profile_node.get("homepage")))
            if contact_items:
                profile["contact"] = "; ".join(_deduplicate_items(contact_items))

            consider(profile)

    return best_profile


def _extract_prefill_from_lines(lines: list[str]) -> dict[str, Any]:
    """从 cleaner 产出的主内容文本里抽"明显有标签"的字段，避免和 LLM 做重复工作。"""

    prefill: dict[str, Any] = {}

    for line in lines[:8]:
        candidate = re.sub(r"^(?:Prof\.?|Professor|Dr\.?|Mr\.?|Ms\.?|Mrs\.?)\s+", "", line, flags=re.I)
        candidate = candidate.split(" / ", 1)[0].strip()
        candidate = candidate.split(",", 1)[0].strip()
        if _looks_like_person_name_candidate(candidate):
            prefill["name"] = candidate
            break

    for line in lines[:15]:
        if len(line) > 100 or AFFILIATION_SKIP_RE.search(line):
            continue
        if "institution" not in prefill:
            chinese_match = re.search(
                r"([\u4e00-\u9fff]{2,30}"
                r"(?:理工大学|工业大学|科技大学|师范大学|农业大学|医科大学|财经大学|政法大学|外国语大学"
                r"|大学|学院|研究院|研究所|科学院|医院))",
                line,
            )
            if chinese_match:
                prefill["institution"] = chinese_match.group(1)
            elif re.fullmatch(
                r"(?:The\s+)?[A-Z][A-Za-z&.\- ]+(?:University|Polytechnic|Institute of Technology)",
                line,
                re.I,
            ):
                prefill["institution"] = _normalize_space(line)

        dept_matches = re.findall(
            r"(Department of [A-Z][A-Za-z&,\- ]+|School of [A-Z][A-Za-z&,\- ]+|Faculty of [A-Z][A-Za-z&,\- ]+|"
            r"College of [A-Z][A-Za-z&,\- ]+|Institute of [A-Z][A-Za-z&,\- ]+|"
            r"[\u4e00-\u9fff]{2,30}(?:学院|系|研究所|实验室))",
            line,
        )
        if dept_matches and "college_department" not in prefill:
            prefill["college_department"] = " / ".join(_deduplicate_items(dept_matches[:2]))

        if "academic_title" not in prefill:
            title_value = _match_title_value(line, ACADEMIC_TITLE_PATTERNS)
            if title_value:
                prefill["academic_title"] = title_value

    admin_titles: list[str] = []
    for line in lines[:25]:
        admin_value = _match_title_value(line, ADMIN_TITLE_PATTERNS)
        if admin_value:
            admin_titles.append(admin_value)
    if admin_titles:
        prefill["admin_title"] = "; ".join(_deduplicate_items(admin_titles))

    for index, line in enumerate(lines):
        match = RESEARCH_LABEL_RE.match(line)
        if not match:
            continue
        tail = _normalize_space(match.group(1) or "")
        collected: list[str] = []
        if tail:
            collected.extend(_split_semantic_items(tail))
        else:
            for candidate in _collect_following_block(lines, index, limit=5):
                collected.extend(_split_semantic_items(candidate))
        collected = [item for item in _deduplicate_items(collected) if len(item) >= 2]
        if collected:
            prefill["research_areas"] = collected[:12]
            break

    for index, line in enumerate(lines):
        if not BIO_LABEL_RE.match(line):
            continue
        paragraphs = _collect_following_block(lines, index, limit=3)
        if paragraphs:
            prefill["bio"] = _normalize_space(" ".join(paragraphs))[:300]
            break

    if "bio" not in prefill:
        for line in lines:
            if len(line) >= 80 and not BACKUP_CONTACT_RE.search(line):
                prefill["bio"] = line[:300]
                break

    contact_items: list[str] = []
    for line in lines[:40]:
        if not BACKUP_CONTACT_RE.search(line):
            continue
        cleaned = re.sub(r"[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+", "", line, flags=re.I)
        cleaned = re.sub(r"\+?\d[\d()\-\s]{6,}\d", "", cleaned)
        cleaned = _normalize_space(cleaned)
        if cleaned:
            contact_items.append(cleaned)
    if contact_items:
        prefill["contact"] = "; ".join(_deduplicate_items(contact_items[:4]))

    return prefill


def _sanitize_prefill(prefill: dict[str, Any]) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    for key, value in prefill.items():
        if isinstance(value, list):
            items = _deduplicate_items(str(item) for item in value)
            if items:
                cleaned[key] = items
            continue
        normalized = _normalize_space(str(value)) if value is not None else ""
        if normalized:
            cleaned[key] = normalized
    return cleaned


def _remap_prefill_fields(prefill: dict[str, Any]) -> dict[str, Any]:
    """把 cleaner 预填结果对齐到新的 API 字段名。

    这里尽量不改动前面的抽取启发式，只在出口统一命名：
    - 直接一一对应的字段做重命名；
    - `research_areas` 同时作为 `domain` 的候选证据，以及 `direction` 的兜底来源；
    - 列表值先保留原状，交给后面的规范化层决定是取首个命中、还是压成逗号字符串。
    """

    renamed: dict[str, Any] = {}
    direct_mapping = {
        "name": "surname",
        "institution": "organization",
        "college_department": "department",
        "academic_title": "professional",
        "admin_title": "position",
        "bio": "content",
        "social_positions": "academic",
        "journal_resources": "journal",
    }
    for source_key, target_key in direct_mapping.items():
        value = prefill.get(source_key)
        if value not in (None, "", [], {}):
            renamed[target_key] = value

    research_items = prefill.get("research_areas")
    if research_items not in (None, "", [], {}):
        renamed.setdefault("domain", research_items)
        renamed.setdefault("direction", research_items)

    for passthrough_key in ("contact", "title", "tags", "country", "province", "sex", "birthday"):
        value = prefill.get(passthrough_key)
        if value not in (None, "", [], {}):
            renamed[passthrough_key] = value
    return renamed


def extract_prefill(html: str) -> dict[str, Any]:
    """提取可直接预填进最终 JSON 的候选字段。

    这里的定位不是"替代 LLM"，而是先把高置信度字段喂给合并层和 LLM，
    让模型把精力集中在翻译、归纳和难字段判断上。
    """

    soup = BeautifulSoup(html, "lxml")
    extraction = extract(html, _soup=soup)
    lines = _deduplicate_items(_extract_dom_lines(soup) + _content_lines_from_text(extraction.text))

    prefill = _extract_structured_prefill(soup)
    line_prefill = _extract_prefill_from_lines(lines)

    # 结构化数据优先，因为它通常比 DOM 文本更稳定；文本规则负责补齐缺口。
    merged_prefill = {**line_prefill, **prefill}
    if extraction.author and "institution" not in merged_prefill and extraction.author != extraction.title:
        merged_prefill.setdefault("contact", extraction.author)
    return _remap_prefill_fields(_sanitize_prefill(merged_prefill))


def extract(html: str, *, _soup: Optional[BeautifulSoup] = None) -> ExtractionResult:
    """提取主容器正文，并返回调试信息供 A/B 对比。"""

    soup = _soup if _soup is not None else BeautifulSoup(html, "lxml")
    title, author, publish_time = _extract_metadata(soup)
    container, strategy = _select_main_container(soup)

    if container is None:
        text = _build_output_text(title, author, publish_time, [])
        return ExtractionResult(
            title=title,
            author=author,
            publish_time=publish_time,
            strategy="empty",
            selector_hint="",
            text_length=len(text),
            text=text,
        )

    cleaned_root = deepcopy(container)
    _remove_noise(cleaned_root)
    lines = _deduplicate_lines(_iter_text_blocks(cleaned_root))
    text = _build_output_text(title, author, publish_time, lines)
    structured_lines = _extract_structured_lines(soup)
    structured_text = _build_output_text(title, author, publish_time, structured_lines) if structured_lines else ""

    selector_hint = _tag_descriptor(container)

    if structured_lines:
        # 结构化数据（JSON-LD / window.__DATA__）质量最高，始终 prepend 到正文前面，
        # 让 LLM 优先看到高置信度的字段；DOM 正文作为补充上下文跟在后面。
        structured_block = "\n".join(structured_lines)
        if len(text) < 300:
            # DOM 正文过短（JS 渲染页面），结构化数据作为主要内容
            text = _build_output_text(title, author, publish_time, structured_lines)
            strategy = f"{strategy}+structured"
            selector_hint += " -> structured-data"
        else:
            # DOM 正文充足，结构化数据作为高置信度前缀
            text = _build_output_text(
                title, author, publish_time,
                [f"[结构化数据] {structured_block}", "---"] + lines,
            )
            strategy = f"{strategy}+structured-prepend"

    return ExtractionResult(
        title=title,
        author=author,
        publish_time=publish_time,
        strategy=strategy,
        selector_hint=selector_hint,
        text_length=len(text),
        text=text,
    )


def clean(html: str) -> str:
    """兼容旧 cleaner 接口，只返回文本。"""

    return extract(html).text


def _is_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"}


def _load_source(source: str) -> tuple[str, str]:
    if _is_url(source):
        # 复用现有 fetch 逻辑，确保代理/反爬回退策略保持一致。
        from extract import fetch

        html, final_url = fetch(source)
        return html, final_url

    path = Path(source)
    html = path.read_text(encoding="utf-8", errors="replace")
    return html, str(path.resolve())


def _cli(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Standalone OpenCLI-style HTML cleaner.")
    parser.add_argument("source", help="Local HTML path or URL")
    parser.add_argument("--out", help="Write extracted text to a file")
    parser.add_argument("--json", action="store_true", help="Print extraction metadata as JSON")
    args = parser.parse_args(argv)

    html, _final_url = _load_source(args.source)
    result = extract(html)
    if args.out:
        Path(args.out).write_text(result.text, encoding="utf-8")

    if args.json:
        payload = asdict(result)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        sys.stdout.write(result.text)
        if not result.text.endswith("\n"):
            sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
