# Extraction Pipeline

Read this when you're debugging the extractor, adding a site adapter, or changing layer priorities. For day-to-day invocation, `SKILL.md` is enough.

## Overview

```
fetch → rules → prefill → LLM → merge → normalize → validate
```

Each layer is a pure function over HTML (and for fetch, the URL). `extract.py::extract_profile` composes them.

## Layers

### 1. fetch

`extract.py::fetch` fetches the URL, with proxy / direct fallback driven by `EXPERT_EXTRACTOR_PROXY_MODE` plus per-domain overrides. Detects anti-bot challenge pages (`pardon our interruption`, cf-mitigated, etc.) and routes around them rather than passing a challenge page to the rest of the pipeline.

For local HTML, `fetch` just reads the file and uses `--source-url` (if provided) for relative URL resolution.

### 2. rules layer — `rules.py`

Handles **high-confidence fields** where a regex / DOM rule beats an LLM:

- `email`, `phone`, `tel` — pattern matched, phone numbers classified as mobile vs landline by `contact_numbers.py`.
- `avatar` — picks name-specific images over generic OG images.
- `surname` — extracted from `<title>`, headings, structured data. Rejects generic site titles ("Web of Science", "Faculty Directory").
- `country` — guessed from TLD / domain when other signals are missing.

### 3. prefill layer — `html_cleaner_opencli.py`

Does two things:

1. **Clean** the HTML to plain text (`clean()`), stripping chrome so the LLM gets a focused prompt.
2. **Prefill** structured fields (`extract_prefill()`) directly from DOM structure — things like `<meta>` tags, obvious "Department:" labels, known faculty-page templates. Outputs use the new field names (`organization`, `department`, `professional`, etc.) so there's no intermediate schema.

### 4. LLM layer — `llm_client.py` + `prompts/extract.txt`

Called with the cleaned text and the rules+prefill fields as `known_fields` context. Responsible for the fuzzier fields: translation, summarization, free-text fields (`content`, `academic`, `journal`, `direction`, `position`). Also gets a chance to correct prefill values.

Skip with `--rules-only` when the LLM is down or you want deterministic debug output.

### 5. merge — `extract.py::_merge`

Priority per field:

1. **rules** (highest confidence — identity and contact fields)
2. **LLM** (judgement fields)
3. **prefill** (fallback)

Rule-only fields (`email`, `phone`, `tel`, `avatar`) bypass the LLM entirely — the LLM is never asked to invent contact info.

### 6. normalize — `response_formatter.py`

Turns loose strings into the final API shape: dictionary lookups via `dict_search.py`, `title` bitmask assembly, `tags` ID joining, `sex` enum, `birthday` format coercion. No renaming — internal field names already match the API.

### 7. validate — `extract.py::_validate_expert_profile_evidence`

Minimum-evidence check before returning `status: 200`. Rejects pages where almost nothing expert-like was extracted, with URL-shape leniency for obvious profile paths (`/profile`, `/faculty`, etc.).

If this check fails, `extract_profile` raises `ValueError("Insufficient expert-profile evidence ...")`, which surfaces as the most common failure signal the agent sees.

## Data files

All under `data/`:

| File | Used by |
|---|---|
| `countries.csv` | `dict_search` → `country` |
| `country_calling_codes.csv` | `rules` / `dict_search` → `countryCode` |
| `academic_titles.csv` | title flag lookup |
| `title_flags.csv` | `title` bitmask values |
| `domains.csv` | `dict_search` → `domain` |
| `tags.csv` | `dict_search` → `tags` |

## Extending

- **New site with special structure**: prefer adding rules in `html_cleaner_opencli.py` (prefill selectors) or `rules.py` (regex). Only add a dedicated site adapter when structural extraction truly can't work — and if you do, put it behind a URL check at the top of `extract_profile`.
- **New dictionary term**: add a row to the relevant CSV in `data/`; `dict_search.py` picks it up without code changes.
- **New output field**: add it to `schema.py`, the prompt in `prompts/extract.txt`, and the LLM / prefill layers as appropriate. Update `response_formatter.py` for any normalization, and `references/schema.md` for documentation.
