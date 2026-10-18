#!/usr/bin/env python3
"""导出 SWE-bench 实例为 runner 读取的 JSONL。

依赖：pip install datasets（建议放在 ~/swebench-venv）。
HuggingFace 在部分网络环境下不可达，默认使用镜像；如本机可直连可显式覆盖：

    export HF_ENDPOINT=https://hf-mirror.com
    python export_instances.py \
        --dataset princeton-nlp/SWE-bench_Lite \
        --split test --limit 10 --output instances.jsonl

也可以显式指定题目（保持请求顺序）：

    python export_instances.py --dataset princeton-nlp/SWE-bench_Lite \
        --split test --instance-ids django__django-11099 pytest-dev__pytest-7432

只导出七个字段：instance_id、repo、base_commit、problem_statement、
FAIL_TO_PASS、PASS_TO_PASS、version。FAIL_TO_PASS / PASS_TO_PASS 在部分
数据集版本里是 JSON 字符串，这里统一归一化为字符串数组。
"""

import argparse
import json
import os
import sys

# 必须在 import datasets 之前设置：datasets 读取 HF_ENDPOINT 决定下载源
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

from datasets import load_dataset

FIELDS = (
    "instance_id",
    "repo",
    "base_commit",
    "problem_statement",
    "FAIL_TO_PASS",
    "PASS_TO_PASS",
    "version",
)


def normalize_tests(value):
    """把测试列表归一化为字符串数组（兼容 JSON 字符串形式）。"""
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return [value]
        if isinstance(parsed, list):
            return [str(item) for item in parsed]
        return [value]
    return [str(item) for item in value]


def parse_args():
    parser = argparse.ArgumentParser(
        description="Export SWE-bench instances to JSONL",
    )
    parser.add_argument(
        "--dataset",
        default="princeton-nlp/SWE-bench_Lite",
        help="HuggingFace dataset name (default: princeton-nlp/SWE-bench_Lite)",
    )
    parser.add_argument("--split", default="test", help="dataset split (default: test)")
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="keep at most N instances after filtering",
    )
    parser.add_argument(
        "--instance-ids",
        nargs="*",
        default=None,
        help="explicit instance ids; output keeps the requested order",
    )
    parser.add_argument(
        "--output",
        default="instances.jsonl",
        help="output JSONL path (default: instances.jsonl)",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    print(f"loading {args.dataset} split={args.split} ...", file=sys.stderr)
    dataset = load_dataset(args.dataset, split=args.split)

    rows = list(dataset)
    if args.instance_ids:
        by_id = {row["instance_id"]: row for row in rows}
        missing = [iid for iid in args.instance_ids if iid not in by_id]
        if missing:
            raise SystemExit(f"unknown instance id(s): {', '.join(missing)}")
        rows = [by_id[iid] for iid in args.instance_ids]

    if args.limit is not None:
        if args.limit < 0:
            raise SystemExit("--limit must be non-negative")
        rows = rows[: args.limit]

    output_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(output_dir, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as handle:
        for row in rows:
            record = {field: row[field] for field in FIELDS}
            record["FAIL_TO_PASS"] = normalize_tests(record["FAIL_TO_PASS"])
            record["PASS_TO_PASS"] = normalize_tests(record["PASS_TO_PASS"])
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    print(f"wrote {len(rows)} instance(s) to {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
