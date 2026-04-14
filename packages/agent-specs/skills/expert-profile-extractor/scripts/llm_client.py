"""OpenAI-compatible client for the LLM extraction step."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

try:
    from openai import OpenAI
except ImportError:  # noqa: F401
    OpenAI = None  # type: ignore


PROMPT_PATH = Path(__file__).parent / "prompts" / "extract.txt"

# ── 自动加载 .env ────────────────────────────────────────────────────────────
def _load_dotenv() -> None:
    """Walk up from this file until we find a .env, then load it into os.environ.
    Values already set in the environment take precedence (don't overwrite).
    No external dependencies needed — this is intentionally a minimal parser.
    """
    search = Path(__file__).resolve()
    for _ in range(8):           # search up to 8 levels up
        search = search.parent
        env_file = search / ".env"
        if env_file.is_file():
            for line in env_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, raw_val = line.partition("=")
                key = key.strip()
                val = raw_val.strip().strip('"').strip("'")
                if key and val and key not in os.environ:
                    os.environ[key] = val
            break

_load_dotenv()
# ────────────────────────────────────────────────────────────────────────────


def _env(*names: str, default: Optional[str] = None) -> Optional[str]:
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return default


def _llm_timeout_seconds() -> float:
    raw = _env(
        "EXPERT_EXTRACTOR_LLM_TIMEOUT_SECONDS",
        "EXPERT_EXTRACTOR_TIMEOUT_SECONDS",
        default="90",
    )
    try:
        return float(raw or "90")
    except ValueError:
        return 90.0


def _client() -> "OpenAI":
    if OpenAI is None:
        raise RuntimeError("openai package not installed; run pip install -r scripts/requirements.txt")
    base_url = _env(
        "EXPERT_EXTRACTOR_BASE_URL",
        "ALIYUN_BAILIAN_BASE_URL",
        "DASHSCOPE_BASE_URL",
        "RIGHT_CODES_BASE_URL",
        default="https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    api_key = _env(
        "EXPERT_EXTRACTOR_API_KEY",
        "ALIYUN_BAILIAN_API_KEY",
        "DASHSCOPE_API_KEY",
        "RIGHT_CODES_API_KEY",
    )
    if not api_key:
        raise RuntimeError(
            "Set EXPERT_EXTRACTOR_API_KEY, ALIYUN_BAILIAN_API_KEY, DASHSCOPE_API_KEY, or RIGHT_CODES_API_KEY to call the LLM."
        )
    return OpenAI(
        base_url=base_url,
        api_key=api_key,
        timeout=_llm_timeout_seconds(),
        max_retries=0,
    )


def _model() -> str:
    return _env(
        "EXPERT_EXTRACTOR_MODEL",
        "ALIYUN_BAILIAN_MODEL_ID",
        "DASHSCOPE_MODEL",
        "DASHSCOPE_MODEL_ID",
        "RIGHT_CODES_MODEL_ID",
        default="glm-5",
    ) or "glm-5"


def call_llm(cleaned_text: str, known: dict, source_url: str) -> dict:
    """Send cleaned text + known fields to the LLM, receive JSON dict."""
    system_prompt = PROMPT_PATH.read_text(encoding="utf-8")

    user_payload = {
        "source_url": source_url,
        "known_fields_from_rules": {k: v for k, v in known.items() if v},
        "page_text": cleaned_text,
    }

    resp = _client().chat.completions.create(
        model=_model(),
        response_format={"type": "json_object"},
        temperature=0,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
        ],
    )
    raw = resp.choices[0].message.content or "{}"
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Last-ditch: try to salvage by stripping markdown fences
        raw = raw.strip().lstrip("`").rstrip("`")
        if raw.startswith("json"):
            raw = raw[4:].lstrip()
        return json.loads(raw)
