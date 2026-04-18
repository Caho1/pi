"""CSV-backed dictionary lookup for expert-profile fields.

设计动机：
----------
业务方的职称/研究领域/国家/头衔都是字典表外键，skill 抽出来的自由字符串如果不能
绑定到字典编码，业务方就没法回填。这个模块负责把 LLM 输出的自由字符串"翻译"成
`{value: <id>, name: <canonical>}` 结构。

分层查找（由严到宽）：
1. exact  —— 规范名精确命中（大小写/全角半角/空格标点已归一化）
2. alias  —— 别名精确命中
3. substring —— 规范名或别名作为 query 的连续子串（仅允许长度 ≥2 的候选）
4. bigram —— 字符 bigram Dice 相似度 ≥ threshold（默认 0.7）

为什么不用 BM25：业务字典条目普遍很短（2–10 字），且中文没有空白分词，BM25 的
空格/标点 tokenizer 会把整条标签当一个 token，毫无意义。字符 bigram 对短文本更
贴脸。

为什么阈值设高（0.7）：把 "量子计算" 误绑到 "人工智能" 比返回 null 危险得多，
因为一旦错绑就污染专家库。宁缺毋滥。

CLI 使用：
  python dict_search.py domains "具身智能"
  python dict_search.py countries "USA" --threshold 0.8
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Optional

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# 字典名称 → CSV 文件。新加字典只需要在这里补一行和放一个 CSV。
DICTIONARIES: dict[str, str] = {
    "academic_titles": "academic_titles.csv",
    "domains": "domains.csv",
    "countries": "countries.csv",
    "title_flags": "title_flags.csv",
    "tags": "tags.csv",
}

DEFAULT_THRESHOLD = 0.7

# 归一化时要抹掉的标点与空白。这里故意不去掉 `-`，因为英文别名里有用到
# （如 Cote d'Ivoire、New Zealand 连字符）。
_PUNCT_RE = re.compile(
    r"[\s\u3000·.,，。、;；:：!！?？()（）\[\]【】\"'`~<>《》/\\|]+"
)


def _normalize(s: str) -> str:
    """NFKC + lower + 去标点空白，用来做相等/包含比较。"""
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s)
    s = s.lower().strip()
    s = _PUNCT_RE.sub("", s)
    return s


def _bigrams(s: str) -> set[str]:
    if len(s) < 2:
        return {s} if s else set()
    return {s[i : i + 2] for i in range(len(s) - 1)}


def _dice(a: str, b: str) -> float:
    ba, bb = _bigrams(a), _bigrams(b)
    if not ba or not bb:
        return 0.0
    return 2 * len(ba & bb) / (len(ba) + len(bb))


@lru_cache(maxsize=None)
def _load(name: str) -> tuple[dict, ...]:
    """读取 CSV 并返回归一化后的只读条目列表（带缓存）。"""
    if name not in DICTIONARIES:
        raise ValueError(f"unknown dictionary: {name!r}")
    path = DATA_DIR / DICTIONARIES[name]
    if not path.exists():
        raise FileNotFoundError(f"dictionary CSV missing: {path}")

    rows: list[dict] = []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            raw_id = (raw.get("id") or "").strip()
            canonical = (raw.get("canonical") or "").strip()
            if not raw_id or not canonical:
                continue
            try:
                entry_id = int(raw_id)
            except ValueError:
                continue
            aliases_raw = (raw.get("aliases") or "").strip()
            aliases = [a.strip() for a in aliases_raw.split("|") if a.strip()]
            rows.append(
                {
                    "id": entry_id,
                    "canonical": canonical,
                    "aliases": aliases,
                    "canonical_norm": _normalize(canonical),
                    "alias_norms": [_normalize(a) for a in aliases],
                }
            )
    return tuple(rows)


def lookup(
    dictionary: str,
    query: object,
    *,
    threshold: float = DEFAULT_THRESHOLD,
) -> Optional[dict]:
    """查 `query` 在 `dictionary` 里的最佳匹配。

    Returns
    -------
    None 当字典里找不到足够可信的匹配。
    否则返回 ``{"value": int, "name": str, "score": float, "method": str}``，
    其中 ``value`` 就是业务字典的编码，``name`` 是规范中文标签。
    """
    if query is None:
        return None
    if not isinstance(query, (str, int, float)):
        return None
    q_raw = str(query).strip()
    if not q_raw:
        return None
    q_norm = _normalize(q_raw)
    if not q_norm:
        return None

    rows = _load(dictionary)

    # Tier 1: exact canonical
    for row in rows:
        if row["canonical_norm"] and row["canonical_norm"] == q_norm:
            return _result(row, score=1.0, method="exact")

    # Tier 2: exact alias
    for row in rows:
        for alias_norm in row["alias_norms"]:
            if alias_norm and alias_norm == q_norm:
                return _result(row, score=0.95, method="alias")

    # Tier 3: candidate (canonical or alias) 是 query 的子串。
    # 比如 "副教授（硕导）" → 命中 "副教授"。
    # 只接受长度 >=2 的候选，避免单字在长句里乱命中。
    # 如果多条都匹配，取最长那条，这样 "副教授..." 不会错绑到 "教授"。
    best_sub: Optional[tuple[int, dict]] = None
    for row in rows:
        for cand_norm in (row["canonical_norm"], *row["alias_norms"]):
            if len(cand_norm) < 2:
                continue
            if cand_norm in q_norm:
                if best_sub is None or len(cand_norm) > best_sub[0]:
                    best_sub = (len(cand_norm), row)
    if best_sub is not None:
        return _result(best_sub[1], score=0.85, method="substring")

    # Tier 4: bigram Dice 相似度。阈值默认 0.7，宁缺毋滥。
    best: Optional[tuple[float, dict]] = None
    for row in rows:
        for cand_norm in (row["canonical_norm"], *row["alias_norms"]):
            if not cand_norm:
                continue
            s = _dice(q_norm, cand_norm)
            if best is None or s > best[0]:
                best = (s, row)
    if best is not None and best[0] >= threshold:
        return _result(best[1], score=round(best[0], 3), method="bigram")

    return None


def _result(row: dict, *, score: float, method: str) -> dict:
    return {
        "value": row["id"],
        "name": row["canonical"],
        "score": score,
        "method": method,
    }


def _main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description="Lookup a query against a business dictionary (expert-profile).",
    )
    ap.add_argument("dictionary", choices=list(DICTIONARIES.keys()))
    ap.add_argument("query")
    ap.add_argument(
        "--threshold",
        type=float,
        default=DEFAULT_THRESHOLD,
        help=f"Bigram Dice similarity threshold (default: {DEFAULT_THRESHOLD})",
    )
    args = ap.parse_args(argv)
    result = lookup(args.dictionary, args.query, threshold=args.threshold)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(_main())
