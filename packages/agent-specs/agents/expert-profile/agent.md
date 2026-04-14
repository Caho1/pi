# Expert Profile Agent

Extract an 18-field structured profile from an expert / faculty / researcher homepage. The schema is shaped to feed the 数字化系统「专家主页同步」弹窗 — each field maps directly to a sync checkbox on that popup.

## Input

The task's `input.prompt` contains either:

- a URL to the profile page, or
- a local HTML file path (plus an optional `source_url` in `structuredInput` for avatar resolution).

Batch jobs may pass `structuredInput.urls: string[]`.

## Execution

Run the bundled skill's pipeline — do **not** reimplement extraction inline. The skill is linked via `skillRefs` and lives at:

```
packages/agent-specs/skills/expert-profile-extractor/
```

Typical invocation:

```bash
python packages/agent-specs/skills/expert-profile-extractor/scripts/extract.py <URL>
```

For batch jobs, use `--batch --out results.jsonl`.

## Output

Call `submit_result` exactly once with the JSON object matching `outputContract.schema`:

- 15 base fields: `name`, `gender`, `birth_date`, `country_region`, `institution`, `college_department`, `research_areas`, `research_directions`, `academic_title`, `admin_title`, `phone`, `email`, `contact_preferred`, `bio`, `avatar_url`
- 3 sync-popup extensions:
  - `social_positions` — string array of concurrent society/association/committee roles
  - `journal_resources` — string array of editorial/reviewer roles (venue + role)
  - `tags` — fixed-shape object with enum-constrained lists: `academic_honors`, `institution_tier`, `experiences`, `others`
- plus `_meta` (source_url, extracted_at, fields_from_rule, fields_from_llm, fields_missing)

Missing scalar fields are `null`; missing list fields are `[]`; missing `tags` is the empty-shape object `{"academic_honors": [], "institution_tier": [], "experiences": [], "others": []}`. Never fabricate values to "fill in" the schema. Any `tags` value outside the predefined enum whitelist is dropped by the post-processing layer — so returning unknown strings there is wasted effort.

## Environment

Preferred extractor configuration:

- `ALIYUN_BAILIAN_API_KEY` (+ optional `ALIYUN_BAILIAN_BASE_URL`, `ALIYUN_BAILIAN_MODEL_ID`)

The bundled extractor script also accepts:

- `EXPERT_EXTRACTOR_API_KEY` (+ optional `EXPERT_EXTRACTOR_BASE_URL`, `EXPERT_EXTRACTOR_MODEL`)
- `DASHSCOPE_API_KEY` (+ optional `DASHSCOPE_BASE_URL`, `DASHSCOPE_MODEL`)
- `RIGHT_CODES_API_KEY` (+ optional `RIGHT_CODES_BASE_URL`, `RIGHT_CODES_MODEL_ID`)

## Failure modes to surface

- Page is JS-rendered and the raw HTML has no profile data → `fields_missing` count > 8 on what appears to be a real profile; mention "likely JS-rendered, consider headless fetch" in a diagnostics note, but still submit whatever was captured.
- Multiple people on one page → refuse and return `_error: "multiple profiles on page"`.
- HTTP error on fetch → return `_error` with the status code; do not retry silently beyond the platform's retryPolicy.
