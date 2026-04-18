"""Agent-only wrapper around `extract.py`.

这个脚本只做一件事：把 `extract.py` 的完整业务响应包装
`{"status": 200, "data": {...}}` 拆成纯 `data` 对象输出给 agent。

这样 agent 不需要自己理解字段映射，更不应该手工重建 JSON；
它只需要把这里打印出来的对象原样提交给 `submit_result`。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Optional


sys.path.insert(0, str(Path(__file__).parent))

from extract import extract_profile


def _cli(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description="Run expert-profile extraction and print only the final structured data object.",
    )
    ap.add_argument("source", help="URL or local HTML path")
    ap.add_argument("--source-url", help="Override source URL when the input is a local HTML file")
    ap.add_argument("--existing-bio", help="Optional current bio text")
    ap.add_argument("--rules-only", action="store_true", help="Skip the LLM call for offline debugging")
    args = ap.parse_args(argv)

    try:
        result = extract_profile(
            args.source,
            source_url_override=args.source_url,
            rules_only=args.rules_only,
            existing_bio=args.existing_bio or os.environ.get("EXPERT_PROFILE_EXISTING_BIO"),
        )
    except Exception as error:
        # 这里故意把错误写到 stderr 并返回非 0，让 agent 直接把任务判失败，
        # 避免模型在脚本失败后退回到“手工阅读网页再瞎填 JSON”的坏路径。
        print(
            json.dumps(
                {
                    "status": 500,
                    "error": str(error),
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 1

    if result.get("status") != 200 or not isinstance(result.get("data"), dict):
        print(
            json.dumps(result, ensure_ascii=False),
            file=sys.stderr,
        )
        return 1

    print(json.dumps(result["data"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
