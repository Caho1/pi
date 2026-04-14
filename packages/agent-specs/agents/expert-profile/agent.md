# Expert Profile Agent

Extract a 15-field structured profile from an expert / faculty / researcher homepage.

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

- 15 data fields (name, gender, birth_date, country_region, institution, college_department, research_areas, research_directions, academic_title, admin_title, phone, email, contact_preferred, bio, avatar_url)
- plus `_meta` (source_url, extracted_at, fields_from_rule, fields_from_llm, fields_missing)

Missing fields are `null` (or `[]` for list fields). Never fabricate values to "fill in" the schema.

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
