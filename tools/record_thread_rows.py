#!/usr/bin/env python3
"""Record the Python rows in suites/harness-thread-rows/cases.json.

Runs prism-harness-py's real ``assistant_row()``, ``tool_result_row()`` and
``thread_view()`` -- the builders AgentRuntime records with and the view it
replays -- on each case.

The case file is edited as TEXT, replacing each ``"py": ...`` string in place and
recomputing ``agrees``, so the recorder cannot reformat or retype the rows it
records.

    PRISM_HARNESS_PY=../prism-harness-py python tools/record_thread_rows.py [--check]
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
HARNESS = Path(os.environ.get("PRISM_HARNESS_PY", ROOT.parent / "prism-harness-py"))
sys.path.insert(0, str(HARNESS / "src"))

from prism_harness import (  # noqa: E402
    ToolCallInput,
    assistant_row,
    thread_view,
    tool_result_row,
)


def rows_for(case: dict[str, Any]) -> list[dict[str, Any]]:
    """The same conversion prism-harness-py/tests/test_thread_rows_corpus.py makes."""
    if "fold" in case:
        return thread_view(case["fold"])

    spec = case["input"]

    if spec["write"] == "assistant":
        return [
            assistant_row(
                spec["content"],
                [
                    ToolCallInput(
                        id=call["id"],
                        name=call["name"],
                        arguments=call["arguments"],
                        result_id=call.get("result_id"),
                        reasoning_id=call.get("reasoning_id"),
                        reasoning_summary=call.get("reasoning_summary"),
                    )
                    for call in spec["tool_calls"]
                ],
                spec["additional_content"],
                spec["approval_requests"],
            )
        ]

    return [
        tool_result_row(
            [
                {
                    "tool_call_id": result["tool_call_id"],
                    "tool_name": result["tool_name"],
                    "args": result["args"],
                    "result": result["result"],
                    "tool_call_result_id": result.get("tool_call_result_id"),
                    "artifacts": [],
                }
                for result in spec["results"]
            ],
            spec["decisions"],
        )
    ]


def encode(value: Any) -> str:
    """Compact JSON with non-ASCII and slashes left as they are, as the reference writes it."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def string_end(text: str, quote: int) -> int:
    i = quote + 1
    while i < len(text):
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == '"':
            return i + 1
        i += 1
    raise ValueError("Unterminated string in the case file.")


def main() -> int:
    check = "--check" in sys.argv
    path = ROOT / "suites" / "harness-thread-rows" / "cases.json"
    raw = path.read_text(encoding="utf-8")
    document = json.loads(raw)
    stale: list[str] = []

    for case in document["cases"]:
        produced = encode(rows_for(case))

        if case["rows"]["py"] != produced:
            stale.append(case["id"])

        at = raw.index(f'"id": "{case["id"]}"')
        quote = raw.index('"py": ', at) + len('"py": ')
        raw = raw[:quote] + encode(produced) + raw[string_end(raw, quote) :]

        agrees = produced == case["rows"]["php"] and produced == case["rows"]["ts"]
        value_at = raw.index('"agrees": ', at) + len('"agrees": ')
        value_end = value_at + (4 if raw.startswith("true", value_at) else 5)
        raw = raw[:value_at] + ("true" if agrees else "false") + raw[value_end:]

    if check:
        if stale:
            print(f"Stale py rows: {', '.join(stale)}", file=sys.stderr)
            return 1
        print("Python rows current.", file=sys.stderr)
        return 0

    path.write_text(raw, encoding="utf-8", newline="")
    print(f"Wrote {len(document['cases'])} py row set(s); {len(stale)} changed.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
