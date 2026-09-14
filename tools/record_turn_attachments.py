#!/usr/bin/env python3
"""Record the Python verdicts in suites/harness-turn-attachments/cases.json.

Runs prism-harness-py's real ``admit_attachments()`` on each case. The case file
is edited as TEXT, replacing each ``"py": ...`` verdict in place, so the recorder
cannot reformat or retype the rows it records.

    PRISM_HARNESS_PY=../prism-harness-py python tools/record_turn_attachments.py [--check]
"""

from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
HARNESS = Path(os.environ.get("PRISM_HARNESS_PY", ROOT.parent / "prism-harness-py"))
sys.path.insert(0, str(HARNESS / "src"))

from prism_harness import HarnessError, admit_attachments  # noqa: E402


class _FromFile:
    """What prism-ai-core's from_local_path() gives a caller: media that knows it came
    from a file, and serializes as bytes with no path."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def to_dict(self) -> dict[str, Any]:
        return dict(self._payload)

    def is_url(self) -> bool:
        return False

    def is_file(self) -> bool:
        return True


def attachment_for(spec: dict[str, Any]) -> object:
    """The same spec, built the way a Python caller would hold it.

    Mirrored in prism-harness-py/tests/test_turn_attachments_corpus.py.
    """
    if spec["$"] == "Text":
        return {"text": spec["text"]}
    if spec["$"] == "String":
        return spec["value"]

    kind = "document" if spec["$"] == "Document" else "image"
    base: dict[str, Any] = {
        "kind": kind,
        "url": None,
        "base64": None,
        "mime_type": spec.get("mimeType"),
        "file_id": None,
        "filename": None,
    }

    def titled(payload: dict[str, Any]) -> dict[str, Any]:
        if kind != "document":
            return payload
        return {**payload, "document_title": spec.get("title"), "chunks": payload.get("chunks")}

    source = spec["from"]
    if source == "base64":
        return titled({**base, "base64": spec["base64"]})
    if source == "url":
        return titled({**base, "url": spec["url"]})
    if source == "urlWithBytes":
        return titled({**base, "url": spec["url"], "base64": spec["base64"]})
    if source == "localPath":
        encoded = base64.b64encode(spec["bytes"].encode("utf-8")).decode("ascii")
        return _FromFile(titled({**base, "base64": encoded}))
    if source == "fileId":
        return titled({**base, "file_id": spec["fileId"]})
    if source == "chunks":
        return titled({**base, "chunks": spec["chunks"]})
    if source == "text":
        encoded = base64.b64encode(spec["text"].encode("utf-8")).decode("ascii")
        return titled({**base, "base64": encoded, "mime_type": "text/plain"})
    if source == "nothing":
        return titled(base)
    raise ValueError(f"Unknown media source {source}")


def main() -> int:
    check = "--check" in sys.argv
    path = ROOT / "suites" / "harness-turn-attachments" / "cases.json"
    raw = path.read_text(encoding="utf-8")
    document = json.loads(raw)
    stale: list[str] = []

    for case in document["cases"]:
        try:
            admit_attachments(case["prompt"], [attachment_for(spec) for spec in case["attachments"]])
            verdict = "admitted"
        except HarnessError as refused:
            verdict = str(refused.code)

        if case["verdict"]["py"] != verdict:
            stale.append(case["id"])

        at = raw.index(f'"id": "{case["id"]}"')
        verdict_at = raw.index('"py": ', at)
        end = raw.index('"', verdict_at + len('"py": "'))
        raw = f'{raw[:verdict_at]}"py": "{verdict}{raw[end:]}'

    if check:
        if stale:
            print(f"Stale py verdicts: {', '.join(stale)}", file=sys.stderr)
            return 1
        print("PY verdicts current.", file=sys.stderr)
        return 0

    path.write_text(raw, encoding="utf-8", newline="\n")
    print(f"Wrote {len(document['cases'])} py verdict(s); {len(stale)} changed.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
