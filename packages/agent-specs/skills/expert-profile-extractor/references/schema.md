# Expert Profile Output Schema

The extractor returns the 22-field business API shape directly. On success `extract.py` prints `{"status": 200, "data": {...}}`; `extract_for_agent.py` prints only the inner `data` object.

## Field table

| Field | Type | Meaning |
|---|---|---|
| `avatar` | string \| null | Absolute URL to the expert's portrait image. |
| `surname` | string \| null | The person's name as it appears on the page. Chinese names kept as-is. |
| `sex` | int (0/1/2) | `0` unknown, `1` male, `2` female. |
| `birthday` | string \| null | `YYYY-MM-DD`. |
| `country` | int | Country dictionary ID (see `data/countries.csv`). `0` if unknown. |
| `countryCode` | int \| null | ITU calling code (see `data/country_calling_codes.csv`). |
| `province` | int | Province/state dictionary ID. `0` if unknown. |
| `city` | int | City dictionary ID. `0` if unknown. |
| `organization` | string \| null | Institution / university / company name. |
| `department` | string \| null | School / faculty / department inside the organization. |
| `domain` | int | Research-domain dictionary ID (see `data/domains.csv`). `0` if unknown. |
| `direction` | string \| null | Free-text research directions. Comma-joined when multiple. |
| `professional` | int | Professional-category dictionary ID. `0` if unknown. |
| `position` | string \| null | Free-text job title / position ("教授", "副院长"). |
| `phone` | string \| null | Mobile number, normalized. |
| `tel` | string \| null | Landline / office number, normalized. |
| `email` | string \| null | Primary email. |
| `contact` | string \| null | Any contact channel that isn't phone / tel / email (e.g. WeChat, ORCID). |
| `content` | string \| null | Bio / profile paragraph. |
| `academic` | string \| null | Academic achievements, awards, memberships. |
| `journal` | string \| null | Notable publications / journal activity. |
| `title` | int | Academic title **bitmask** (see below). |
| `tags` | string \| null | Comma-separated tag IDs. |

## Enum details

### `sex`
`0` unknown, `1` male, `2` female. Left as `0` unless there's an explicit signal (pronouns, 先生/女士, titles like "Mr/Ms").

### `country / province / city / domain / professional`
Integer dictionary IDs. The lookup tables live alongside the script:

- `data/countries.csv`
- `data/country_calling_codes.csv`
- `data/domains.csv`
- (province / city / professional use the same lookup style; unknown values stay `0`)

`scripts/dict_search.py` resolves raw strings (Chinese or English) to IDs. If no confident match, the ID stays `0` — downstream systems treat `0` as unknown.

### `title` (bitmask)
`title` is a **bitwise OR** of flags from `data/title_flags.csv`. A person who is both `院士` and `博士生导师` has both bits set in a single integer. `0` means no title detected. Do not interpret it as a single enum.

### `tags`
Comma-separated tag IDs from `data/tags.csv`, e.g. `"12,47,83"`. `null` when no tags match. Never a JSON array — always a comma-joined string or `null`.

## Contact semantics

- `phone` — mobile (handset / cell).
- `tel` — landline / office / fax.
- `email` — single preferred email.
- `contact` — everything else (WeChat, QQ, ORCID, Twitter, lab URL). One short human-readable string, not JSON.

## Empty / unknown conventions

- **String fields**: `null`, never `""`.
- **Integer enums** (`sex`, `country`, `province`, `city`, `domain`, `professional`, `title`): `0` when unknown.
- **`tags`**: `null` when no tag fires, not `""` and not `"0"`.

The page should dictate the value. If there's no evidence, leave it empty — don't guess from surrounding context.
