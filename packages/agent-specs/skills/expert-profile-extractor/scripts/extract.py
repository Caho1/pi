"""Entry point — fetch → clean → rule → LLM → merge → JSON."""
from __future__ import annotations

import argparse
import json
import os
import sys
from contextlib import contextmanager, nullcontext
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import requests

# Allow running as a script
sys.path.insert(0, str(Path(__file__).parent))

import html_cleaner
import html_cleaner_opencli
import response_formatter
import rules
import webofscience
from schema import (
    LIST_FIELDS,
    LLM_FIELDS,
    OBJECT_FIELDS,
    ExpertProfile,
)


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
PROXY_ENV_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
)
FALLBACK_STATUS_CODES = {403, 407, 408, 409, 429, 500, 502, 503, 504}
BLOCK_PAGE_MARKERS = (
    "pardon our interruption",
    "just a moment",
    "enable javascript and cookies",
    "cf-mitigated",
    "captcha",
    "security challenge",
)


def _is_url(s: str) -> bool:
    p = urlparse(s)
    return p.scheme in ("http", "https")


def _env_csv(name: str) -> tuple[str, ...]:
    raw = os.environ.get(name, "")
    return tuple(part.strip().lower() for part in raw.split(",") if part.strip())


def _matches_domain(hostname: str, patterns: tuple[str, ...]) -> bool:
    host = hostname.strip(".").lower()
    for pattern in patterns:
        normalized = pattern.lstrip("*.").strip(".")
        if not normalized:
            continue
        if host == normalized or host.endswith(f".{normalized}"):
            return True
    return False


@contextmanager
def _no_proxy_direct_env():
    previous = {key: os.environ.get(key) for key in PROXY_ENV_KEYS}
    try:
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            os.environ.pop(key, None)
        os.environ["NO_PROXY"] = "*"
        os.environ["no_proxy"] = "*"
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _request_with_optional_direct_retry(url: str, *, force_no_proxy: bool = False) -> requests.Response:
    session = requests.Session()
    session.trust_env = not force_no_proxy
    session.headers.update({"User-Agent": USER_AGENT})
    env_ctx = _no_proxy_direct_env() if force_no_proxy else nullcontext()
    with env_ctx:
        response = session.get(url, timeout=20)
    response.raise_for_status()
    return response


def _proxy_mode() -> str:
    mode = (os.environ.get("EXPERT_EXTRACTOR_PROXY_MODE") or "auto").strip().lower()
    if mode in {"proxy-only", "direct-only", "direct-first"}:
        return mode
    return "auto"


def _request_plan(url: str) -> list[bool]:
    hostname = (urlparse(url).hostname or "").lower()
    force_direct_domains = _env_csv("EXPERT_EXTRACTOR_FORCE_DIRECT_DOMAINS")
    force_proxy_domains = _env_csv("EXPERT_EXTRACTOR_FORCE_PROXY_DOMAINS")

    # 域名级策略优先于全局模式：已知“代理会坏”的站点直接走直连，
    # 已知“必须翻出去”的站点固定走代理，避免每次都靠人工切环境变量。
    if hostname and _matches_domain(hostname, force_direct_domains):
        return [True]
    if hostname and _matches_domain(hostname, force_proxy_domains):
        return [False]

    mode = _proxy_mode()
    if mode == "direct-only":
        return [True]
    if mode == "proxy-only":
        return [False]
    if mode == "direct-first":
        return [True, False]
    return [False, True]


def _is_retryable_for_alternate_route(error: requests.exceptions.RequestException) -> bool:
    if not isinstance(error, requests.exceptions.HTTPError):
        return True
    status_code = error.response.status_code if error.response is not None else None
    return status_code in FALLBACK_STATUS_CODES


def _looks_like_block_page(response: requests.Response) -> bool:
    marker_sources = [
        response.text[:4000].lower(),
        response.headers.get("cf-mitigated", "").lower(),
        response.headers.get("server", "").lower(),
    ]
    return any(marker in source for source in marker_sources for marker in BLOCK_PAGE_MARKERS)


def _fetch_url(url: str) -> requests.Response:
    attempts = _request_plan(url)
    last_error: Exception | None = None

    for index, force_no_proxy in enumerate(attempts):
        has_alternate = index < len(attempts) - 1
        try:
            response = _request_with_optional_direct_retry(url, force_no_proxy=force_no_proxy)
            # 一些学校站或 Cloudflare 会返回 200，但正文其实是挑战页；
            # 这种情况下优先切另一条网络路径，而不是把拦截页交给后续清洗/抽取。
            if _looks_like_block_page(response):
                if has_alternate:
                    continue
                raise RuntimeError("Request was blocked by an anti-bot or access challenge page")
            return response
        except requests.exceptions.RequestException as error:
            last_error = error
            if has_alternate and _is_retryable_for_alternate_route(error):
                continue
            raise

    if last_error is not None:
        raise last_error
    raise RuntimeError(f"Failed to fetch '{url}' with any configured proxy route")


def fetch(url_or_path: str, source_url_override: Optional[str] = None) -> tuple[str, str]:
    """Return (html, final_url)."""
    if _is_url(url_or_path):
        r = _fetch_url(url_or_path)
        # requests guesses; for CJK pages apparent_encoding is more accurate
        if r.encoding and r.encoding.lower() == "iso-8859-1":
            r.encoding = r.apparent_encoding
        return r.text, r.url

    p = Path(url_or_path)
    if not p.exists():
        raise FileNotFoundError(url_or_path)
    html = p.read_text(encoding="utf-8", errors="replace")
    return html, source_url_override or f"file://{p.resolve()}"


def _default_value(field: str):
    if field in LIST_FIELDS:
        return []
    if field in OBJECT_FIELDS:
        return {}
    return None


def _is_empty(field: str, value) -> bool:
    if value in (None, "", [], {}):
        return True
    if field in {"sex", "country", "province", "city", "domain", "professional", "title"} and value == 0:
        return True
    return False


def _merge_known_fields(rule_fields: dict, prefill_fields: dict) -> dict:
    """把规则层和预填层合成一份 known_fields，供 LLM 作为高置信度上下文使用。"""

    merged = dict(prefill_fields)
    merged.update({k: v for k, v in rule_fields.items() if not _is_empty(k, v)})
    return merged


def _pick_cleaned_text(html: str) -> str:
    """优先使用 OpenCLI 风格 cleaner，文本过短时再回退到旧 cleaner。"""

    opencli_text = html_cleaner_opencli.clean(html)
    legacy_text = html_cleaner.clean(html)

    if len(opencli_text.strip()) >= 200:
        return opencli_text
    if len(legacy_text.strip()) > len(opencli_text.strip()):
        return legacy_text
    return opencli_text or legacy_text


def _merge(rule_fields: dict, llm_fields: dict, prefill_fields: dict) -> tuple[dict, list, list]:
    """合并优先级：规则层 > LLM > 预填层。

    这样做的目的是：
    1. 规则层继续保留最高优先级，避免误覆盖 email/phone/avatar 等稳定字段；
    2. LLM 仍有机会把英文职称、机构名翻成中文，或者把预填候选修正得更自然；
    3. 当 LLM 留空时，预填层还能兜底，把 JSON 先补齐一部分。
    """

    merged: dict = {}
    from_rule, from_llm = [], []

    for f in LLM_FIELDS:
        rv = rule_fields.get(f)
        lv = llm_fields.get(f)
        pv = prefill_fields.get(f)
        if not _is_empty(f, rv):
            merged[f] = rv
            from_rule.append(f)
        elif not _is_empty(f, lv):
            merged[f] = lv
            from_llm.append(f)
        elif not _is_empty(f, pv):
            merged[f] = pv
            from_rule.append(f)
        else:
            merged[f] = _default_value(f)

    # Rule-only fields
    for f in ("email", "phone", "avatar"):
        v = rule_fields.get(f)
        if _is_empty(f, v):
            v = prefill_fields.get(f)
        merged[f] = v
        if not _is_empty(f, v):
            from_rule.append(f)

    return merged, from_rule, from_llm


def extract_profile(
    url_or_path: str,
    *,
    source_url_override: Optional[str] = None,
    rules_only: bool = False,
    existing_bio: Optional[str] = None,
) -> dict:
    if _is_url(url_or_path):
        wos_profile = webofscience.extract_profile(url_or_path)
        if wos_profile is not None:
            return wos_profile

    html, final_url = fetch(url_or_path, source_url_override)

    rule_fields = rules.extract_all(html, final_url)
    prefill_fields = html_cleaner_opencli.extract_prefill(html)
    known_fields = _merge_known_fields(rule_fields, prefill_fields)

    if rules_only:
        llm_fields: dict = {}
    else:
        import llm_client  # imported lazily so --rules-only doesn't need openai pkg
        cleaned = _pick_cleaned_text(html)
        llm_fields = llm_client.call_llm(
            cleaned,
            known_fields,
            final_url,
            existing_bio=existing_bio,
        )

    merged, _, _ = _merge(rule_fields, llm_fields, prefill_fields)
    normalized = response_formatter.normalize_profile(merged)
    profile = ExpertProfile(**normalized)
    return {"status": 200, "data": profile.model_dump()}


def _cli(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Extract expert profile into a structured JSON.")
    ap.add_argument("source", help="URL, local HTML path, or a file of URLs if --batch")
    ap.add_argument("--out", help="Write output to this file (default: stdout)")
    ap.add_argument("--source-url", help="When source is a local HTML, override the URL used for avatar resolution / TLD")
    ap.add_argument("--existing-bio", help="Optional current bio text; when provided, the LLM rewrites bio using both sources")
    ap.add_argument("--rules-only", action="store_true", help="Skip the LLM call; useful for offline rule-layer testing")
    ap.add_argument("--batch", action="store_true", help="Treat source as a newline-delimited list of URLs")
    ap.add_argument("--concurrency", type=int, default=1, help="(batch) concurrent workers")
    args = ap.parse_args(argv)

    if args.batch:
        return _run_batch(args)

    try:
        existing_bio = args.existing_bio or os.environ.get("EXPERT_PROFILE_EXISTING_BIO")
        result = extract_profile(
            args.source,
            source_url_override=args.source_url,
            rules_only=args.rules_only,
            existing_bio=existing_bio,
        )
    except Exception as e:  # top-level: report cleanly
        err = {"status": 500, "data": None, "error": str(e)}
        print(json.dumps(err, ensure_ascii=False, indent=2))
        return 1

    out = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(out, encoding="utf-8")
    else:
        print(out)
    return 0


def _run_batch(args) -> int:
    from concurrent.futures import ThreadPoolExecutor, as_completed

    urls = [line.strip() for line in Path(args.source).read_text().splitlines() if line.strip()]
    out_stream = open(args.out, "w", encoding="utf-8") if args.out else sys.stdout

    def _one(u: str) -> dict:
        try:
            return extract_profile(u, rules_only=args.rules_only)
        except Exception as e:
            return {"status": 500, "data": None, "error": str(e)}

    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        futs = {pool.submit(_one, u): u for u in urls}
        for fut in as_completed(futs):
            out_stream.write(json.dumps(fut.result(), ensure_ascii=False) + "\n")
            out_stream.flush()

    if args.out:
        out_stream.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
