from __future__ import annotations

import json
import os
from pathlib import Path

from prism_harness import AddressLimitExceeded, FileSessionStore, Participant, PrismHarness, StoreAddressIndex

specs = json.loads(Path(__file__).with_name("index-cases.json").read_text(encoding="utf-8"))["cases"]
rows = []
for spec in specs:
    directory = Path(os.environ["PRISM_INDEX_WORK"]) / f"py-{spec['id']}"
    store, participant = FileSessionStore(directory), Participant("index-person", "1")
    harness = PrismHarness(drivers={"owned": lambda: store}, stores={"ephemeral": "owned", "durable": "owned"}, max_addresses_per_participant=spec["max_addresses_per_participant"])
    refusals, error_code, refused_state = 0, None, False
    for number in range(spec["addresses"]):
        session = harness.for_agent("support").for_(participant).session(f"page:{number}")
        try:
            session.using_mode("reply")
        except AddressLimitExceeded as error:
            refusals += 1
            error_code = error.code
            refused_state = refused_state or store.get(f"{session.key()}:ephemeral") is not None
    index, sizes, cursors, positions, cursor = StoreAddressIndex(store), [], [], [], 0
    while True:
        page = index.page(participant, cursor)
        sizes.append(len(page["entries"]))
        cursors.append(page["next_cursor"])
        positions.extend(row["position"] for row in page["entries"])
        if page["next_cursor"] is None:
            break
        cursor = page["next_cursor"]
    harness.for_agent("support").for_(participant).session("page:0").using_mode("updated")
    result = {"indexed":len(positions),"page_sizes":sizes,"next_cursors":cursors,"quota_refusals":refusals,"error_code":error_code,"refused_state_present":refused_state,"positions_dense":positions == list(range(len(positions))),"existing_writable":harness.for_agent("support").for_(participant).session("page:0").mode() == "updated"}
    assert result == spec["expected"], (spec["id"], result)
    rows.append({"id":spec["id"],"result":result})
print(json.dumps(rows, separators=(",", ":")))
