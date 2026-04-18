---
name: expert-profile-extractor
description: Extract a structured expert/faculty profile from a scholar homepage, faculty staff page, or local HTML file into the business API shape. Use whenever the user pastes a researcher/professor/expert profile URL, asks to parse a faculty page, or wants to turn a scholar homepage into structured JSON with fields like organization, department, domain, title, and contact info.
---

# Expert Profile Extractor

Turn a single expert / faculty / researcher homepage into the business API shape via a deterministic pipeline. You (the agent) are responsible for invoking the script, reading its output, and deciding what to do on failure — the script does the extraction and schema conversion, you do the judgment.

## Command

Always run from the repo root. Prefer the agent wrapper, which prints **only** the final `data` object (no `{status, data}` envelope) on success and writes errors to stderr:

```bash
.venv/bin/python packages/agent-specs/skills/expert-profile-extractor/scripts/extract_for_agent.py \
  <URL_OR_HTML_PATH>
```

Use the underlying entry point when you need the full envelope, batch mode, or an `--out` file:

```bash
.venv/bin/python packages/agent-specs/skills/expert-profile-extractor/scripts/extract.py \
  <URL_OR_HTML_PATH> [--out <output.json>] [--batch]
```

Fall back to `python3` if `.venv` doesn't exist.

## Options

| Flag | When to use |
|---|---|
| `--source-url <url>` | Input is a local HTML file and you want relative URLs (avatars, links) resolved against an original URL. |
| `--existing-bio <text>` | You already have a profile bio — the LLM will merge rather than regenerate. |
| `--rules-only` | Skip the LLM pass. Returns what the rule + prefill layers could find. Use for offline debug or when the LLM provider is down. |
| `--batch` | Treat `<source>` as a newline-delimited file of URLs. Outputs JSONL. |

## Environment knobs

Use these when the default path fails; don't set them eagerly.

| Variable | Purpose |
|---|---|
| `EXPERT_EXTRACTOR_PROXY_MODE` | `auto` (default) \| `direct-only` \| `proxy-only` \| `direct-first`. Flip this when a site keeps getting blocked or timing out. |
| `EXPERT_EXTRACTOR_FORCE_DIRECT_DOMAINS` | Comma-separated domains that must go direct. |
| `EXPERT_EXTRACTOR_FORCE_PROXY_DOMAINS` | Comma-separated domains that must go via proxy. |
| `EXPERT_EXTRACTOR_API_KEY` / `EXPERT_EXTRACTOR_BASE_URL` / `EXPERT_EXTRACTOR_MODEL` | LLM client config. |
| `ALIYUN_BAILIAN_API_KEY` / `ALIYUN_BAILIAN_BASE_URL` / `ALIYUN_BAILIAN_MODEL_ID` | Aliyun fallback. |

## Reading the result

On success, stdout is a single JSON object matching the business API shape (22 fields). Submit it verbatim — field IDs, bitmasks, and dictionary lookups are already resolved by the script.

On failure the script exits non-zero and writes JSON like `{"status": 500, "error": "..."}` to stderr. The error message is meaningful — act on it rather than retrying blindly.

## Failure triage

The extractor deliberately fails loudly rather than returning polluted data. Match the error text to a decision:

- **`Insufficient expert-profile evidence`** — the page didn't look like a person detail page. Options, in order: (a) re-run with `--rules-only` to see partial fields; if still empty, the URL is probably a department/index page, surface the failure. (b) If you suspect the content is behind a render, don't guess — fail.
- **`Request was blocked by an anti-bot or access challenge page`** — flip `EXPERT_EXTRACTOR_PROXY_MODE` to the opposite mode and retry once. If still blocked, the site needs a browser-based tool; fail.
- **Timeout / `ConnectionError`** — retry once with a larger bash timeout (≥120s for real URLs). Then fail.
- **LLM/OpenAI error** — retry with `--rules-only`. Non-LLM fields still land, LLM-only fields stay null.

Cap yourself at **two retries total per input**. Do not loop.

## Non-negotiables

- **Never handcraft the JSON.** The final payload must be exactly what the script printed to stdout. Manually filled fields are considered a failed task even if they look right.
- **Never scrape the page yourself to patch missing fields.** If the script couldn't find them, they're not reliably there. It's better to submit a partially-filled profile than a fabricated one.
- **Never guess enum IDs.** `sex / country / province / city / domain / professional / title` and `tags` IDs come from the script's dictionary lookup — guessing them silently corrupts downstream data.

## References

- [references/schema.md](references/schema.md) — full 22-field schema, dictionary ID conventions, `title` bitmask, `tags` encoding. Read when you need to understand the shape of the output.
- [references/architecture.md](references/architecture.md) — fetch → rule → prefill → LLM → merge → normalize pipeline. Read when debugging the script, adding a site-specific adapter, or changing priority rules.

## Testing

```bash
python3 -m unittest \
  tests/test_html_cleaner_opencli.py \
  tests/test_html_cleaner_opencli_structured.py \
  tests/test_skill_logic.py
```
