"""Specialized extractor for Web of Science author record pages."""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
from contextlib import contextmanager, nullcontext
from typing import Any, Optional

import requests

from schema import ALL_FIELDS, ExpertProfile, ProfileMeta, empty_tags


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
SEARCH_API_URL = "https://www.webofscience.com/api/esti/SearchEngine/search"
AUTHOR_RECORD_RE = re.compile(
    r"^https?://(?:www\.)?webofscience\.com/wos/author/record/(?P<spid>[\w\-]+)$",
    re.IGNORECASE,
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
COUNTRY_ALIASES = {
    "VIETNAM": "越南",
    "CHINA": "中国",
    "AUSTRALIA": "澳大利亚",
    "UNITED STATES": "美国",
    "USA": "美国",
    "CANADA": "加拿大",
    "UNITED KINGDOM": "英国",
    "UK": "英国",
    "SOUTH KOREA": "韩国",
    "KOREA": "韩国",
    "JAPAN": "日本",
    "GERMANY": "德国",
    "FRANCE": "法国",
    "ITALY": "意大利",
    "SPAIN": "西班牙",
}


def matches(url: str) -> bool:
    return AUTHOR_RECORD_RE.match(url) is not None


def _parse_extra_headers(raw: Optional[str]) -> dict[str, str]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"invalid WOS_HEADERS_JSON / --headers-json: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError("WOS_HEADERS_JSON / --headers-json must be a JSON object")
    parsed: dict[str, str] = {}
    for key, header_value in value.items():
        if isinstance(key, str) and isinstance(header_value, str) and key.strip() and header_value.strip():
            parsed[key.strip()] = header_value.strip()
    return parsed


def _spid_from_url(url: str) -> Optional[str]:
    match = AUTHOR_RECORD_RE.match(url)
    if not match:
        return None
    return match.group("spid")


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


def _request_search(
    payload: dict[str, Any],
    *,
    referer_url: str,
    force_no_proxy: bool = False,
    cookie_header: Optional[str] = None,
    extra_headers: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    session = requests.Session()
    session.trust_env = not force_no_proxy
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": "https://www.webofscience.com",
        "Referer": referer_url,
    }
    if cookie_header:
        headers["Cookie"] = cookie_header
    if extra_headers:
        headers.update(extra_headers)
    env_ctx = _no_proxy_direct_env() if force_no_proxy else nullcontext()
    with env_ctx:
        response = session.post(SEARCH_API_URL, headers=headers, json=payload, timeout=20)
    response.raise_for_status()
    return response.json()


def _search_payload(spid: str) -> dict[str, Any]:
    return {
        "search": {
            "mode": "author_id",
            "database": "AUTHOR",
            "authorId": {"type": "spid", "value": spid},
        },
        "retrieve": {
            "Count": 1,
            "FirstRecord": "1",
            "Options": {
                "View": "AuthorDetail",
                "DataFormat": "Map",
                "ReturnType": "List",
                "RemoveQuery": "On",
            },
        },
    }


def _dedupe_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for value in values:
        cleaned = re.sub(r"\s+", " ", value).strip()
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(cleaned)
    return deduped


def _normalize_name(record: dict[str, Any]) -> Optional[str]:
    publishing_name = record.get("publishingName")
    if isinstance(publishing_name, str) and publishing_name.strip():
        return publishing_name.strip()

    for key in ("authorAliasName", "author_name"):
        raw = record.get(key)
        if not isinstance(raw, str) or not raw.strip():
            continue
        if "," in raw:
            family, given = [part.strip() for part in raw.split(",", 1)]
            if given and family:
                return f"{given} {family}"
        return raw.strip()
    return None


def _normalize_country(location: Any) -> Optional[str]:
    if not isinstance(location, str) or not location.strip():
        return None
    country = location.split(",")[-1].strip().upper()
    if not country:
        return None
    return COUNTRY_ALIASES.get(country, country.title())


def _normalize_department(record: dict[str, Any]) -> Optional[str]:
    parts: list[str] = []
    primary = record.get("primaryInstitutionAffiliation")
    if isinstance(primary, dict):
        department = primary.get("department")
        if isinstance(department, str) and department.strip() and department.strip().lower() != "unknown":
            parts.append(department.strip())

    departments = record.get("primaryAffiliationDepartment")
    if isinstance(departments, list):
        parts.extend(str(item).strip() for item in departments if str(item).strip())

    deduped = _dedupe_strings(parts)
    return " / ".join(deduped) if deduped else None


def _normalize_research_areas(record: dict[str, Any]) -> list[str]:
    categories = record.get("categories")
    if not isinstance(categories, list):
        return []
    return _dedupe_strings([str(item) for item in categories])


def _normalize_research_directions(record: dict[str, Any]) -> list[str]:
    topics = record.get("topics")
    if not isinstance(topics, list):
        return []
    values = []
    for item in topics:
        if isinstance(item, dict) and isinstance(item.get("value"), str):
            values.append(item["value"])
    return _dedupe_strings(values)


def _normalize_institution(record: dict[str, Any]) -> Optional[str]:
    primary = record.get("primaryInstitutionAffiliation")
    if isinstance(primary, dict):
        institution = primary.get("institution")
        if isinstance(institution, str) and institution.strip():
            return institution.strip()

    for key in ("institution", "primaryAffiliation"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _is_session_not_active(error: requests.exceptions.RequestException) -> bool:
    response = getattr(error, "response", None)
    if response is None:
        return False
    try:
        payload = response.json()
    except Exception:
        return False
    return isinstance(payload, dict) and payload.get("code") == "Server.sessionNotActive"


def extract_profile(
    url: str,
    *,
    cookie_header: Optional[str] = None,
    extra_headers: Optional[dict[str, str]] = None,
) -> Optional[dict[str, Any]]:
    spid = _spid_from_url(url)
    if not spid:
        return None

    payload = _search_payload(spid)
    cookie_header = cookie_header or os.environ.get("WOS_COOKIE")
    resolved_extra_headers = {
        **_parse_extra_headers(os.environ.get("WOS_HEADERS_JSON")),
        **(extra_headers or {}),
    }
    try:
        response = _request_search(
            payload,
            referer_url=url,
            cookie_header=cookie_header,
            extra_headers=resolved_extra_headers,
        )
    except requests.exceptions.RequestException as error:
        if _is_session_not_active(error) and not cookie_header:
            raise RuntimeError(
                "Web of Science API requires an active session. "
                "For server-side use, provide WOS_COOKIE or --cookie, and optionally "
                "WOS_HEADERS_JSON / --headers-json from a validated browser session."
            ) from error
        if not _looks_like_tls_handshake_error(error):
            raise
        response = _request_search(
            payload,
            referer_url=url,
            force_no_proxy=True,
            cookie_header=cookie_header,
            extra_headers=resolved_extra_headers,
        )

    records = (((response.get("Data") or {}).get("Records")) or [])
    if not records:
        raise RuntimeError(f"Web of Science API returned no author records for spid '{spid}'")

    record = records[0]
    if not isinstance(record, dict):
        raise RuntimeError("Web of Science API returned malformed author payload")

    merged = {
        "name": _normalize_name(record),
        "gender": None,
        "birth_date": None,
        "country_region": _normalize_country(record.get("primaryAffiliationLocation")),
        "institution": _normalize_institution(record),
        "college_department": _normalize_department(record),
        "research_areas": _normalize_research_areas(record),
        "research_directions": _normalize_research_directions(record),
        "academic_title": None,
        "admin_title": None,
        "phone": None,
        "email": None,
        "contact_preferred": None,
        "bio": record.get("summary") if isinstance(record.get("summary"), str) else None,
        "avatar_url": record.get("photoUrlLarge") if isinstance(record.get("photoUrlLarge"), str) else None,
        # Web of Science's author API does not expose these — leave empty; the
        # generic pipeline will populate them when a homepage URL is used instead.
        "social_positions": [],
        "journal_resources": [],
        "tags": empty_tags(),
    }

    def _is_empty(field: str, value) -> bool:
        if field == "tags":
            return not isinstance(value, dict) or all(not value.get(k) for k in value)
        return value in (None, "", [])

    fields_from_api = sorted([field for field in ALL_FIELDS if not _is_empty(field, merged.get(field))])
    missing = [field for field in ALL_FIELDS if _is_empty(field, merged.get(field))]

    meta = ProfileMeta(
        source_url=url,
        extracted_at=_dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        fields_from_rule=fields_from_api,
        fields_from_llm=[],
        fields_missing=missing,
    )
    profile = ExpertProfile(**merged, _meta=meta)
    return profile.model_dump(by_alias=True)


def _cli() -> int:
    ap = argparse.ArgumentParser(description="Extract an expert profile from a Web of Science author record URL.")
    ap.add_argument("source", help="Web of Science author record URL such as https://www.webofscience.com/wos/author/record/917221")
    ap.add_argument("--cookie", help="Raw Cookie header from an active Web of Science browser session")
    ap.add_argument("--headers-json", help="JSON object of extra headers to send with the API request")
    args = ap.parse_args()

    try:
        result = extract_profile(
            args.source,
            cookie_header=args.cookie,
            extra_headers=_parse_extra_headers(args.headers_json),
        )
        if result is None:
            raise RuntimeError("source is not a supported Web of Science author record URL")
    except Exception as error:
        print(json.dumps({"_error": str(error), "_meta": {"source_url": args.source}}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
