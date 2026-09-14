#!/usr/bin/env python3
"""Record the Python outputs in suites/opentelemetry-media-content/cases.json.

Runs prism-opentelemetry-py's real ``without_media_bytes()`` and writes the compact
JSON into the case file as TEXT, replacing only the ``"py"`` output literal.

    PRISM_OTEL_PY=../prism-opentelemetry-py python tools/record_media_content.py [--check]
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRIDGE = Path(os.environ.get("PRISM_OTEL_PY", ROOT.parent / "prism-opentelemetry-py"))
sys.path.insert(0, str(BRIDGE / "src"))

from prism_opentelemetry import without_media_bytes  # noqa: E402

BACKSLASH = chr(92)


def literal_end(raw: str, start: int) -> int:
    """Where the JSON string literal whose opening quote is at ``start`` ends."""
    i = start + 1
    while i < len(raw):
        if raw[i] == BACKSLASH:
            i += 2
            continue
        if raw[i] == '"':
            return i + 1
        i += 1
    raise ValueError("Unterminated string literal.")


def main() -> int:
    check = "--check" in sys.argv
    path = ROOT / "suites" / "opentelemetry-media-content" / "cases.json"
    raw = path.read_text(encoding="utf-8")
    document = json.loads(raw)
    stale: list[str] = []

    for case in document["cases"]:
        output = json.dumps(
            without_media_bytes(case["input"]), separators=(",", ":"), ensure_ascii=False
        )
        if case["output"]["py"] != output:
            stale.append(case["id"])

        at = raw.index(f'"id": "{case["id"]}"')
        key = raw.index('"py": ', raw.index('"output": {', at))
        start = key + len('"py": ')
        raw = raw[:start] + json.dumps(output, ensure_ascii=False) + raw[literal_end(raw, start) :]

    if check:
        if stale:
            print(f"Stale py outputs: {', '.join(stale)}", file=sys.stderr)
            return 1
        print("PY outputs current.", file=sys.stderr)
        return 0

    path.write_text(raw, encoding="utf-8", newline="\n")
    print(f"Wrote {len(document['cases'])} py output(s); {len(stale)} changed.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
