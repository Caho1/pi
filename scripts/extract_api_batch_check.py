#!/usr/bin/env python3
"""并发调用 expert-profile extract 接口并生成 Markdown 测试报告。"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


DEFAULT_ENDPOINT = "http://127.0.0.1:3000/v1/expert-profiles/extract"
DEFAULT_DOC_TOKEN = "49d6209cde82775d7d47995d17ce1a2f2b29b7bcb820b4c540f449ba90a74097"
DATA_FIELDS = [
    "avatar",
    "surname",
    "sex",
    "birthday",
    "country",
    "countryCode",
    "province",
    "city",
    "organization",
    "department",
    "domain",
    "direction",
    "professional",
    "position",
    "phone",
    "tel",
    "email",
    "contact",
    "content",
    "academic",
    "journal",
    "title",
    "tags",
]
CORE_FIELDS = ["surname", "organization", "department", "direction", "content", "email"]


@dataclass
class ExtractRunResult:
    index: int
    url: str
    request_id: str
    http_status: int
    elapsed_seconds: float
    response_json: dict[str, Any] | None
    raw_body: str
    error_message: str | None
    started_offset_seconds: float
    finished_offset_seconds: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Batch test /v1/expert-profiles/extract and emit a Markdown report.")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="Extract API endpoint.")
    parser.add_argument(
        "--token",
        default=os.environ.get("EXPERT_PROFILE_API_TOKEN") or DEFAULT_DOC_TOKEN,
        help="Bearer token for the API. Defaults to EXPERT_PROFILE_API_TOKEN or the repo doc token.",
    )
    parser.add_argument("--timeout", type=float, default=240.0, help="Per-request timeout in seconds.")
    parser.add_argument("--concurrency", type=int, default=6, help="Worker count for concurrent requests.")
    parser.add_argument("--output", required=True, help="Markdown report output path.")
    parser.add_argument("--url", action="append", dest="urls", default=[], help="Profile URL to test. Repeatable.")
    args = parser.parse_args()
    if not args.urls:
        parser.error("At least one --url is required.")
    return args


def build_request_id(index: int, source_url: str) -> str:
    digest = hashlib.sha1(source_url.encode("utf-8")).hexdigest()[:8]
    return f"extract-batch-{index:02d}-{digest}"


def post_extract_request(
    *,
    endpoint: str,
    token: str,
    source_url: str,
    request_id: str,
    timeout_seconds: float,
    batch_started_at: float,
    index: int,
) -> ExtractRunResult:
    """发送单条抽取请求，并把 HTTP/JSON/耗时统一包装成稳定结构。"""
    started_at = time.perf_counter()
    payload = json.dumps({"url": source_url, "requestId": request_id}).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }
    request = urllib.request.Request(endpoint, data=payload, headers=headers, method="POST")

    http_status = 0
    body_text = ""
    parsed_json: dict[str, Any] | None = None
    error_message: str | None = None

    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            http_status = response.status
            body_text = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        http_status = exc.code
        body_text = exc.read().decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001
        error_message = str(exc)

    if body_text:
        try:
            loaded = json.loads(body_text)
            if isinstance(loaded, dict):
                parsed_json = loaded
            else:
                error_message = f"Response JSON is not an object: {type(loaded).__name__}"
        except json.JSONDecodeError as exc:
            error_message = f"Invalid JSON response: {exc}"

    finished_at = time.perf_counter()
    return ExtractRunResult(
        index=index,
        url=source_url,
        request_id=request_id,
        http_status=http_status,
        elapsed_seconds=finished_at - started_at,
        response_json=parsed_json,
        raw_body=body_text,
        error_message=error_message,
        started_offset_seconds=started_at - batch_started_at,
        finished_offset_seconds=finished_at - batch_started_at,
    )


def is_populated(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, set, dict)):
        return len(value) > 0
    if isinstance(value, (int, float)):
        return value != 0
    return True


def summarize_data(result: ExtractRunResult) -> dict[str, Any]:
    """抽取报告只看高价值信息：核心字段命中、有效字段数量和明显缺口。"""
    payload = result.response_json or {}
    data = payload.get("data")
    if not isinstance(data, dict):
        return {
            "kind": "error",
            "populated_count": 0,
            "core_missing": CORE_FIELDS[:],
            "notes": [payload.get("error", {}).get("message") or result.error_message or "No data returned"],
            "name": None,
            "organization": None,
            "email": None,
        }

    populated_fields = [field for field in DATA_FIELDS if is_populated(data.get(field))]
    core_missing = [field for field in CORE_FIELDS if not is_populated(data.get(field))]
    notes: list[str] = []
    if core_missing:
        notes.append(f"核心字段缺失: {', '.join(core_missing)}")
    if is_populated(data.get("tel")) and isinstance(data.get("tel"), str):
        tel = data["tel"]
        digits = "".join(ch for ch in tel if ch.isdigit())
        half = len(digits) // 2
        if len(digits) >= 8 and len(digits) % 2 == 0 and digits[:half] == digits[half:]:
            notes.append("固定电话疑似重复拼接")
    if is_populated(data.get("content")) and isinstance(data.get("content"), str) and len(data["content"].strip()) < 40:
        notes.append("简介文本偏短")
    if not notes:
        notes.append("核心字段基本齐全")

    return {
        "kind": "data",
        "populated_count": len(populated_fields),
        "core_missing": core_missing,
        "notes": notes,
        "name": data.get("surname"),
        "organization": data.get("organization"),
        "email": data.get("email"),
    }


def trim_text(value: Any, limit: int = 120) -> str:
    if not isinstance(value, str):
        return "-"
    text = " ".join(value.split())
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1]}…"


def build_outcome_label(result: ExtractRunResult) -> str:
    if result.error_message and not result.response_json:
        return "REQUEST_ERROR"
    if not result.response_json:
        return "INVALID_RESPONSE"
    if result.http_status != 200:
        return "HTTP_ERROR"
    if isinstance(result.response_json.get("data"), dict):
        return "DATA"
    return "NO_DATA"


def build_high_level_findings(results: list[ExtractRunResult], wall_clock_seconds: float, overlap_ratio: float) -> list[str]:
    """把批量结果提炼成几条高信号结论，方便先看结论再钻明细。"""
    findings: list[str] = []
    success_results = [item for item in results if item.http_status == 200 and isinstance((item.response_json or {}).get("data"), dict)]
    total_request_seconds = sum(item.elapsed_seconds for item in results)

    if overlap_ratio > 1.5:
        findings.append(
            f"并发成立：{len(results)} 条请求在 {wall_clock_seconds:.2f}s 内完成，而单请求耗时总和达到 {total_request_seconds:.2f}s。"
        )
    else:
        findings.append(
            f"并发不明显：批次总耗时 {wall_clock_seconds:.2f}s，重叠系数只有 {overlap_ratio:.2f}，需要进一步确认服务端是否串行执行。"
        )

    if success_results:
        ranked = sorted(success_results, key=lambda item: summarize_data(item)["populated_count"], reverse=True)
        best_items = ", ".join(
            f"{summarize_data(item)['name'] or item.url}({summarize_data(item)['populated_count']} 字段)"
            for item in ranked[:2]
        )
        findings.append(f"数据完整度最好的是：{best_items}。")

    empty_profile_sites = []
    running_sites = []
    for item in results:
        error = (item.response_json or {}).get("error")
        if not isinstance(error, dict):
            continue
        if error.get("code") == "empty_profile":
            empty_profile_sites.append(item.url)
        if error.get("message") == "Task finished with status 'RUNNING'":
            running_sites.append(item.url)

    if empty_profile_sites:
        findings.append(f"`empty_profile` 出现在 {len(empty_profile_sites)} 个站点：{'; '.join(empty_profile_sites)}。")
    if running_sites:
        findings.append(
            f"发现超时/状态映射异常：{'; '.join(running_sites)} 返回 `500`，但错误文案仍是 `Task finished with status 'RUNNING'`。"
        )

    return findings


def render_markdown_report(
    *,
    endpoint: str,
    concurrency: int,
    batch_started_at: float,
    batch_finished_at: float,
    results: list[ExtractRunResult],
) -> str:
    """把原始结果压缩成可读报告，方便快速判断并发是否生效以及抽取质量。"""
    utc_now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    wall_clock_seconds = batch_finished_at - batch_started_at
    summed_request_seconds = sum(item.elapsed_seconds for item in results)
    max_request_seconds = max((item.elapsed_seconds for item in results), default=0.0)
    overlap_ratio = summed_request_seconds / wall_clock_seconds if wall_clock_seconds > 0 else 0.0
    success_count = sum(1 for item in results if item.http_status == 200 and isinstance((item.response_json or {}).get("data"), dict))
    error_count = len(results) - success_count
    high_level_findings = build_high_level_findings(results, wall_clock_seconds, overlap_ratio)

    lines = [
        "# Extract 接口并发测试报告",
        "",
        "## 测试概览",
        "",
        f"- 生成时间: {utc_now}",
        f"- 接口地址: `{endpoint}`",
        f"- 并发度: `{concurrency}`",
        f"- 请求总数: `{len(results)}`",
        f"- 成功返回数据: `{success_count}`",
        f"- 失败/异常: `{error_count}`",
        f"- 批次总耗时: `{wall_clock_seconds:.2f}s`",
        f"- 单请求耗时总和: `{summed_request_seconds:.2f}s`",
        f"- 最长单请求耗时: `{max_request_seconds:.2f}s`",
        f"- 重叠系数: `{overlap_ratio:.2f}`",
        "",
        "重叠系数 = 所有请求耗时之和 / 批次总耗时。明显大于 `1.0` 通常说明请求存在并发重叠，而不是串行排队。",
        "",
        "## 关键结论",
        "",
    ]

    lines.extend([f"- {finding}" for finding in high_level_findings])
    lines.extend(
        [
            "",
        "## 汇总表",
        "",
        "| # | 站点 | HTTP | 结果 | 耗时(s) | 有效字段数 | 姓名 | 单位 | 邮箱 | 备注 |",
        "| --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |",
        ]
    )

    for item in results:
        summary = summarize_data(item)
        parsed = urllib.parse.urlparse(item.url)
        site = parsed.netloc or item.url
        lines.append(
            "| {index} | {site} | {http_status} | {outcome} | {elapsed:.2f} | {count} | {name} | {org} | {email} | {note} |".format(
                index=item.index,
                site=site.replace("|", "\\|"),
                http_status=item.http_status or "-",
                outcome=build_outcome_label(item),
                elapsed=item.elapsed_seconds,
                count=summary["populated_count"],
                name=str(summary["name"] or "-").replace("|", "\\|"),
                org=trim_text(summary["organization"], 40).replace("|", "\\|"),
                email=str(summary["email"] or "-").replace("|", "\\|"),
                note=trim_text("；".join(summary["notes"]), 60).replace("|", "\\|"),
            )
        )

    lines.extend(
        [
            "",
            "## 逐条结果",
            "",
        ]
    )

    for item in results:
        payload = item.response_json or {}
        data = payload.get("data")
        error = payload.get("error")
        summary = summarize_data(item)

        lines.extend(
            [
                f"### {item.index}. {item.url}",
                "",
                f"- requestId: `{item.request_id}`",
                f"- HTTP 状态: `{item.http_status}`",
                f"- 耗时: `{item.elapsed_seconds:.2f}s`",
                f"- 时间窗: `{item.started_offset_seconds:.2f}s -> {item.finished_offset_seconds:.2f}s`",
                f"- 结果类型: `{build_outcome_label(item)}`",
                f"- 判断: {'；'.join(summary['notes'])}",
            ]
        )

        if isinstance(data, dict):
            lines.extend(
                [
                    f"- 姓名: `{data.get('surname') or '-'} `",
                    f"- 单位/部门: `{trim_text(data.get('organization'))}` / `{trim_text(data.get('department'))}`",
                    f"- 研究方向: `{trim_text(data.get('direction'))}`",
                    f"- 联系方式: `email={data.get('email') or '-'}` `phone={data.get('phone') or '-'}` `tel={data.get('tel') or '-'}`",
                    f"- 简介摘要: `{trim_text(data.get('content'), 160)}`",
                    f"- 学术兼职: `{trim_text(data.get('academic'))}`",
                    f"- 期刊资源: `{trim_text(data.get('journal'))}`",
                    f"- tags: `{data.get('tags') or '-'}`",
                ]
            )
        elif isinstance(error, dict):
            lines.extend(
                [
                    f"- error.stage: `{error.get('stage')}`",
                    f"- error.code: `{error.get('code')}`",
                    f"- error.message: `{error.get('message')}`",
                ]
            )
        else:
            lines.append(f"- 原始响应: `{trim_text(item.raw_body, 200)}`")

        if item.error_message:
            lines.append(f"- 本地请求异常: `{trim_text(item.error_message, 200)}`")

        lines.append("")

    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    batch_started_at = time.perf_counter()
    results: list[ExtractRunResult] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures = []
        for index, source_url in enumerate(args.urls, start=1):
            request_id = build_request_id(index, source_url)
            futures.append(
                executor.submit(
                    post_extract_request,
                    endpoint=args.endpoint,
                    token=args.token,
                    source_url=source_url,
                    request_id=request_id,
                    timeout_seconds=args.timeout,
                    batch_started_at=batch_started_at,
                    index=index,
                )
            )

        # 这里按完成顺序收集，再按输入顺序排序，既不丢并发结果，也保证报告可比对。
        for future in concurrent.futures.as_completed(futures):
            results.append(future.result())

    batch_finished_at = time.perf_counter()
    results.sort(key=lambda item: item.index)
    report = render_markdown_report(
        endpoint=args.endpoint,
        concurrency=args.concurrency,
        batch_started_at=batch_started_at,
        batch_finished_at=batch_finished_at,
        results=results,
    )

    output_dir = os.path.dirname(os.path.abspath(args.output))
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as handle:
        handle.write(report)

    print(json.dumps({"output": os.path.abspath(args.output), "count": len(results)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
