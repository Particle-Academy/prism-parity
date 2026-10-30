from __future__ import annotations

import json
import sys

import prism_harness as package

rows = []
for row in json.load(open(sys.argv[1], encoding="utf-8"))["cases"]:
    data = row["input"]
    participant = None if data["participant"] is None else package.Participant(**data["participant"])
    if not hasattr(package, "SessionAddress") and data["agent"] is not None:
        result = {"error": "unsupported_named_namespace"}
    else:
        try:
            if hasattr(package, "SessionAddress"):
                address = package.SessionAddress(participant, data["scope"], data["agent"])
                result = {"session_key": None if participant is None else address.session_key(), "thread_key": address.thread_key(), "index_key": address.index_key()}
            else:
                store = package.MemorySessionStore()
                result = {"session_key": package.Session(participant, data["scope"], store, store).key()}
        except (ValueError, TypeError):
            result = {"error": "invalid_address"}
    rows.append({"id": row["id"], "result": result})
print(json.dumps(rows, separators=(",", ":"), ensure_ascii=False))
