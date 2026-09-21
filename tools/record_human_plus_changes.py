#!/usr/bin/env python3
"""Record the Python rows in suites/human-plus-change-feed/cases.json.

Runs prism-human-plus-py's real ``SurfaceChanges.read_from()`` -- the method
``changes_since()`` calls -- over the surface result each case carries.

The result is decoded from the case's RAW TEXT and never re-encoded back into
the file. See the PHP generator's header for why that rule exists; half the rows
here are about a value's TYPE, and Python is the language that tells int from
float.

The case file is edited as TEXT, replacing each ``"py": ...`` string in place
and recomputing ``agrees``, so the recorder cannot reformat or retype the rows
it records.

    PRISM_HUMAN_PLUS_PY=../prism-human-plus-py python tools/record_human_plus_changes.py [--check]
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = Path(os.environ.get("PRISM_HUMAN_PLUS_PY", ROOT.parent / "prism-human-plus-py"))
sys.path.insert(0, str(PACKAGE / "src"))

from prism_human_plus import ChangeFeed, SurfaceChanges  # noqa: E402


def answer_for(case: dict[str, Any]) -> dict[str, Any]:
    """The same conversion prism-human-plus-py's corpus test makes."""
    result = json.loads(case["input"]["result"])
    feed = ChangeFeed(case["input"]["feed"])

    return SurfaceChanges.read_from(result if isinstance(result, dict) else {}, feed).to_dict()


def string_end(raw: str, quote: int) -> int:
    """The offset just past the JSON string literal that starts at ``quote``."""
    index = quote + 1

    while index < len(raw):
        if raw[index] == "\\":
            index += 2
            continue
        if raw[index] == '"':
            return index + 1
        index += 1

    raise RuntimeError("Unterminated string in the case file.")


def main() -> int:
    check = "--check" in sys.argv
    path = ROOT / "suites" / "human-plus-change-feed" / "cases.json"
    raw = path.read_text(encoding="utf-8")
    document = json.loads(raw)
    stale: list[str] = []

    for case in document["cases"]:
        produced = json.dumps(answer_for(case), separators=(",", ":"), ensure_ascii=False)

        if case["rows"]["py"] != produced:
            stale.append(case["id"])

        at = raw.index(f'"id": "{case["id"]}"')
        quote = raw.index('"py": ', at) + len('"py": ')
        raw = raw[:quote] + json.dumps(produced, ensure_ascii=False) + raw[string_end(raw, quote) :]

        agrees = produced == case["rows"]["php"] and produced == case["rows"]["ts"]
        value_at = raw.index('"agrees": ', at) + len('"agrees": ')
        value_end = value_at + (4 if raw.startswith("true", value_at) else 5)
        raw = raw[:value_at] + ("true" if agrees else "false") + raw[value_end:]

    if check:
        if stale:
            sys.stderr.write(f"Stale py rows: {', '.join(stale)}\n")
            return 1

        sys.stderr.write("Python rows current.\n")
        return 0

    path.write_text(raw, encoding="utf-8", newline="\n")
    sys.stderr.write(f"Wrote {len(document['cases'])} py answer(s); {len(stale)} changed.\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
