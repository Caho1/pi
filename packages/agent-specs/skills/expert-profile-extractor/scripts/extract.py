"""Entry point — fetch → clean → rule → LLM → merge → JSON."""
from __future__ import annotations

import argparse
import datetime as _dt
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
import rules
import webofscience
from schema import (
    ALL_FIELDS,
    LIST_FIELDS,
    LLM_FIELDS,
    OBJECT_FIELDS,
    ExpertProfile,
    ProfileMeta,
    empty_tags,
    is_empty_tags,
    sanitize_tags,
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
TLS_ERROR_MARKERS = (
    "ssl",
    "tls",
    "wrong version number",
    "eof occurred in violation of protocol",
    "secure tls connection",
    "ssl_error_syscall",
)


def _is_url(s: str) -> bool:
    p = urlparse(s)
    return p.scheme in ("http", "https")


def _looks_like_tls_handshake_error(error: Exception) -> bool:
    if isinstance(error, requests.exceptions.SSLError):
        return True
    message = str(error).lower()
    return any(marker in message for marker in TLS_ERROR_MARKERS)


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


def fetch(url_or_path: str, source_url_override: Optional[str] = None) -> tuple[str, str]:
    """Return (html, final_url)."""
    if _is_url(url_or_path):
        try:
            r = _request_with_optional_direct_retry(url_or_path)
        except requests.exceptions.RequestException as error:
            if not _looks_like_tls_handshake_error(error):
                raise
            try:
                r = _request_with_optional_direct_retry(url_or_path, force_no_proxy=True)
            except requests.exceptions.RequestException as direct_error:
                raise RuntimeError(
                    f"TLS handshake failed; no_proxy direct retry also failed: {direct_error}"
                ) from error
        # requests guesses; for CJK pages apparent_encoding is more accurate
        if r.encoding and r.encoding.lower() == "iso-8859-1":
            r.encoding = r.apparent_encoding
        return r.text, r.url

    p = Path(url_or_path)
    if not p.exists():
        raise FileNotFoundError(url_or_path)
    html = p.read_text(encoding="utf-8", errors="replace")
    return html, source_url_override or f"file://{p.resolve()}"


def _derive_preferred(email: Optional[str], phone: Optional[str]) -> Optional[str]:
    if email:
        return "email"
    if phone:
        return "phone"
    return None


def _default_value(field: str):
    if field in LIST_FIELDS:
        return []
    if field in OBJECT_FIELDS:
        return empty_tags()
    return None


def _is_empty(field: str, value) -> bool:
    if field in OBJECT_FIELDS:
        return is_empty_tags(value)
    return value in (None, "", [])


def _merge(rule_fields: dict, llm_fields: dict) -> tuple[dict, list, list]:
    """Rule-layer values win; LLM fills gaps and provides non-rule fields."""
    merged: dict = {}
    from_rule, from_llm = [], []

    for f in LLM_FIELDS:
        rv = rule_fields.get(f)
        lv = llm_fields.get(f)
        if f in OBJECT_FIELDS:
            # Sanitize against the enum whitelist before accepting.
            lv = sanitize_tags(lv)

        if not _is_empty(f, rv):
            merged[f] = rv
            from_rule.append(f)
        elif not _is_empty(f, lv):
            merged[f] = lv
            from_llm.append(f)
        else:
            merged[f] = _default_value(f)

    # Rule-only fields
    for f in ("email", "phone", "avatar_url"):
        v = rule_fields.get(f)
        merged[f] = v
        if v:
            from_rule.append(f)

    return merged, from_rule, from_llm


def extract_profile(
    url_or_path: str,
    *,
    source_url_override: Optional[str] = None,
    rules_only: bool = False,
) -> dict:
    if _is_url(url_or_path):
        wos_profile = webofscience.extract_profile(url_or_path)
        if wos_profile is not None:
            return wos_profile

    html, final_url = fetch(url_or_path, source_url_override)

    rule_fields = rules.extract_all(html, final_url)

    if rules_only:
        llm_fields: dict = {}
    else:
        import llm_client  # imported lazily so --rules-only doesn't need openai pkg
        cleaned = html_cleaner.clean(html)
        llm_fields = llm_client.call_llm(cleaned, rule_fields, final_url)

    merged, from_rule, from_llm = _merge(rule_fields, llm_fields)
    merged["contact_preferred"] = _derive_preferred(merged.get("email"), merged.get("phone"))

    missing = [f for f in ALL_FIELDS if _is_empty(f, merged.get(f))]

    meta = ProfileMeta(
        source_url=final_url,
        extracted_at=_dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        fields_from_rule=sorted(set(from_rule)),
        fields_from_llm=sorted(set(from_llm)),
        fields_missing=missing,
    )

    profile = ExpertProfile(**merged, _meta=meta)
    return profile.model_dump(by_alias=True)


def _cli(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Extract expert profile into an 18-field JSON.")
    ap.add_argument("source", help="URL, local HTML path, or a file of URLs if --batch")
    ap.add_argument("--out", help="Write output to this file (default: stdout)")
    ap.add_argument("--source-url", help="When source is a local HTML, override the URL used for avatar resolution / TLD")
    ap.add_argument("--rules-only", action="store_true", help="Skip the LLM call; useful for offline rule-layer testing")
    ap.add_argument("--batch", action="store_true", help="Treat source as a newline-delimited list of URLs")
    ap.add_argument("--concurrency", type=int, default=1, help="(batch) concurrent workers")
    args = ap.parse_args(argv)

    if args.batch:
        return _run_batch(args)

    try:
        result = extract_profile(
            args.source,
            source_url_override=args.source_url,
            rules_only=args.rules_only,
        )
    except Exception as e:  # top-level: report cleanly
        err = {"_error": str(e), "_meta": {"source_url": args.source}}
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
            return {"_error": str(e), "_meta": {"source_url": u}}

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
