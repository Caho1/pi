---
name: expert-profile-extractor
description: Extract structured expert/faculty profile data from scholar homepages, faculty staff pages, researcher profile URLs, or HTML files. Produces a strict 18-field JSON: name, gender, birth date, country/region, institution, college/department, research areas, research directions, academic title, administrative title, phone, email, preferred contact, bio, avatar URL, social positions (社会兼职), journal resources (期刊资源), and a fixed-taxonomy tag object (标签). Use this skill whenever the user asks to extract, scrape, parse, or collect info from an expert homepage, faculty page, researcher profile, teacher profile, scholar bio page, professor page, or similar — even if they don't say "extract" explicitly, e.g. "get the info from this page", "parse this URL", "what does this professor's page say", "build a profile JSON from this link".
---

# Expert Profile Extractor

Extract a **fixed 18-field JSON** from an expert/faculty/researcher homepage. The profiles come in wildly different layouts (Chinese universities, Middle Eastern universities, personal pages, institutional directories) so the extractor combines deterministic HTML rules with an LLM fallback to stay robust across structures.

The output is shaped to feed the 数字化系统「专家主页同步」弹窗 right column — each field maps directly to a checkbox in that popup.

## When to use this skill

Use it whenever the task is "turn a professor/researcher/expert homepage into structured data". Typical phrasings:

- "Extract this faculty member's info: <url>"
- "Scrape this teacher profile into JSON"
- "Parse this researcher page"
- "What are Prof. X's research areas / contact / title?" (when given a URL)
- Batch tasks like "crawl these 50 expert pages and give me a CSV"

If the user only wants *one* field (e.g. "just give me the email on this page"), the skill still applies — pull everything, return just that field from the result.

## Output schema (strict)

Always return this exact shape. Missing fields are `null` (or `[]` for list fields), **never** fabricated.

```json
{
  "name": "string | null",
  "gender": "male | female | null",
  "birth_date": "YYYY | YYYY-MM | null",
  "country_region": "string | null",
  "institution": "string | null",
  "college_department": "string | null",
  "research_areas": ["string", ...],
  "research_directions": ["string", ...],
  "academic_title": "string | null",
  "admin_title": "string | null",
  "phone": "string | null",
  "email": "string | null",
  "contact_preferred": "email | phone | other | null",
  "bio": "string | null",
  "avatar_url": "string | null (absolute URL)",
  "social_positions": ["string", ...],
  "journal_resources": ["string", ...],
  "tags": {
    "academic_honors": ["院士头衔 | 校级 | 处级 | 科协会领导 | 学科带头人", ...],
    "institution_tier": ["QS Top 50 | QS Top 100 | QS Top 200 | QS Top 500 | QS Top 1000 | 985 | 211 | 双一流 | 其它", ...],
    "experiences": ["海归 | 有过博士后经历 | 参与学术社团 | 曾担任学术职务", ...],
    "others": ["顶尖学术奖项 | 导师职务 | 深度培训经历 | 一般培训经历 | 兼办 | 外联 | 院校", ...]
  },
  "_meta": {
    "source_url": "string",
    "extracted_at": "ISO-8601 timestamp",
    "fields_from_rule": ["..."],
    "fields_from_llm": ["..."],
    "fields_missing": ["..."]
  }
}
```

The four `tags` categories are **enum-constrained** — any value the LLM returns outside the allowed list is silently dropped during post-processing. See `scripts/schema.py::TAG_ENUMS` for the exact whitelist.

## How to run

The skill bundles a Python pipeline. Call it directly — do not re-implement the extraction inline.

```bash
.venv/bin/python scripts/extract.py <URL_OR_HTML_PATH> [--out <output.json>]
```

Interpreter / timeout guidance:

- Prefer `.venv/bin/python` when the skill directory already contains a virtualenv.
- If `.venv/bin/python` is unavailable, use `python3`. Avoid bare `python` because it is not guaranteed to exist in agent sandboxes.
- If you are running the command through an agent `bash` tool, set the tool timeout to at least `120` seconds for a single real URL. The extractor's own LLM step can exceed 60 seconds on real faculty pages.

For Web of Science author record pages, there is also a dedicated API-backed script:

```bash
python scripts/webofscience.py https://www.webofscience.com/wos/author/record/917221
```

In server environments, Web of Science may require a pre-established session. The script supports:

```bash
export WOS_COOKIE="cookie1=...; cookie2=..."
export WOS_HEADERS_JSON='{"X-Requested-With":"XMLHttpRequest"}'
python scripts/webofscience.py https://www.webofscience.com/wos/author/record/917221
```

Examples:

```bash
# From URL
.venv/bin/python scripts/extract.py https://jiankang.usst.edu.cn/2021/0611/c13509a248959/page.htm

# From local HTML (for offline/test use)
.venv/bin/python scripts/extract.py tests/fixtures/usst_yangjiantao.html --source-url https://jiankang.usst.edu.cn/2021/0611/c13509a248959/page.htm

# Batch
.venv/bin/python scripts/extract.py urls.txt --batch --out results.jsonl
```

The script prints the JSON to stdout and (if `--out` given) writes to file.

### Dependencies

Install once:

```bash
pip install -r scripts/requirements.txt
```

### Environment variables

```bash
# Preferred: Aliyun Bailian / DashScope
export ALIYUN_BAILIAN_API_KEY="..."
export ALIYUN_BAILIAN_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export ALIYUN_BAILIAN_MODEL_ID="glm-5"

# Optional explicit overrides for this skill only
export EXPERT_EXTRACTOR_API_KEY="..."
export EXPERT_EXTRACTOR_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export EXPERT_EXTRACTOR_MODEL="glm-5"
```

If the `EXPERT_EXTRACTOR_*` vars are unset, the client falls back in this order:

- `ALIYUN_BAILIAN_*`
- `DASHSCOPE_*`
- `RIGHT_CODES_*`

## How the extraction works (so Claude can debug intelligently)

The pipeline runs in four stages. Understanding the division of labor lets you reason about failures and pick the right fix.

1. **Fetch** — `requests.get` with a browser User-Agent, 15s timeout. For local paths, read from disk. Relative avatar URLs are later joined against the source URL.

2. **Clean** — `html_cleaner.clean(html)` strips `<script>`, `<style>`, `<noscript>`, `<svg>`, `<iframe>`, `<header>`, `<footer>`, `<nav>`, `<aside>`, `<form>`, plus common chrome selectors (`.breadcrumb`, `.sidebar`, `[role=navigation]`, ...). Returns plain text of the body only, whitespace-collapsed, truncated to ~20K chars. This is what the LLM sees.

3. **Rule layer** — `rules.py` handles fields whose textual pattern is stable across every site:
   - `email` — regex, with a blocklist for `noreply@`, `webmaster@`, `*@*.gov` lookalikes, common footer emails.
   - `phone` — international + CN + US formats.
   - `avatar_url` — priority: `<meta property="og:image">` → `<img>` with `class|id|alt` matching `avatar|photo|portrait|headshot|touxiang|zhaopian` → first `<img>` in a container whose class contains `profile|person|faculty` → first reasonably-sized `<img>` in `<main>`. URLs are absolutized.
   - `name` — `<title>` (stripped of common suffixes like " - University of X") and the first `<h1>` as candidates, reconciled.
   - `country_region` — TLD heuristic (`.cn` → 中国, `.ae` → UAE, `.jp` → 日本, etc.). Acts as a hint, LLM can override with textual evidence.

4. **LLM layer** — one call, JSON mode, `temperature=0`. Receives the cleaned text **and** the rule-layer results as "known fields". The prompt instructs the model to fill missing fields, validate and correct rule guesses only when clearly wrong, and never invent data. See `scripts/prompts/extract.txt`.

5. **Merge + post-process** — rule-layer fields win when populated and validated; `contact_preferred` is derived (`email` > `phone` > other > null); `_meta` records which fields came from where so downstream consumers can trust-weight the output.

## Field-by-field rationale

This is **intentional**, not arbitrary — review before changing:

| Field | Source | Why |
|---|---|---|
| name | rule + LLM reconcile | `<title>`/`<h1>` nearly always carries the name; LLM corrects for suffixes like "Prof." or subtitle bleed |
| gender | LLM only | Almost never written explicitly; must be inferred from pronouns ("she holds...") or Mr/Ms/先生/女士. No name-based guessing (locale-dependent, bias-prone). |
| birth_date | LLM only | Rare on public profiles; occasionally embedded in bio ("born 1975") |
| country_region | TLD + LLM | TLD is a cheap strong prior; LLM overrides on explicit text |
| institution | LLM (og:site_name as hint) | Formal name often differs from domain |
| college_department | LLM | Lives in breadcrumb, sidebar, or heading — no stable selector across sites |
| research_areas / research_directions | LLM | Free-form prose, needs semantic split + dedup |
| academic_title / admin_title | LLM | Lexicon is bounded but position is not — LLM handles CN/EN both |
| phone / email | rule only | Regex beats LLM on both accuracy and cost |
| contact_preferred | derived | Deterministic from email/phone presence |
| bio | LLM (summarize) | Compress to ≤300 chars, keep education + tenure + notable roles |
| avatar_url | rule primary | LLM hallucinates URLs — always prefer DOM-anchored |
| social_positions | LLM only | Concurrent society / association / committee roles. Free-form list (not enum). Do not include the person's primary institutional role — that belongs in `admin_title`. |
| journal_resources | LLM only | Editorial / reviewer roles at journals & conferences. Each item combines venue + role (`"《计算机学报》编委"`). Excludes the person's own publications. |
| tags | LLM + post-process whitelist | Four enum-constrained lists used by the business popup as checkboxes. Unknown values dropped in `sanitize_tags`. Leave empty rather than guess. |

## Gotchas

- **Pages behind JavaScript**: if the profile data isn't in the raw HTML (SPA rendered), this skill will miss most fields. Detect by checking `fields_missing` — if >8 fields missing on what looks like a real profile page, note "page appears to require JS rendering" in the summary to the user and suggest they use a headless browser.
- **Multi-profile pages**: some URLs list many people. If the rule layer finds 3+ distinct emails, raise an error — don't silently extract one arbitrary person.
- **Non-HTTPS / redirects**: `requests` follows redirects by default; the skill records the *final* URL in `_meta.source_url`.
- **Encoding**: Chinese pages sometimes declare GB2312 or GBK. `requests` + bs4 handle this, but don't force `html.decode('utf-8')` anywhere.

## Testing the skill

Offline fixtures live in `tests/fixtures/`. Run without calling the LLM (rule-only mode, for quick sanity):

```bash
.venv/bin/python scripts/extract.py tests/fixtures/usst_yangjiantao.html --rules-only
```

This should populate at minimum `email`, `phone`, `avatar_url`, `name`, `country_region`. If any of those are null on the fixtures, the rule layer has regressed.

Full end-to-end run (uses LLM):

```bash
.venv/bin/python scripts/extract.py tests/fixtures/usst_yangjiantao.html \
  --source-url https://jiankang.usst.edu.cn/2021/0611/c13509a248959/page.htm
```

## Batch mode

Input file with one URL per line; output NDJSON (one JSON per line). Use this when the user asks for "extract these 50 profiles":

```bash
.venv/bin/python scripts/extract.py urls.txt --batch --out results.jsonl --concurrency 4
```

Errors on individual URLs are captured as `{"_error": "...", "_meta": {"source_url": "..."}}` lines, never crash the whole batch.
