from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from prism_harness import FileSessionStore, HarnessError, MemorySessionStore, Participant, PrismHarness
from prism_harness.stores._file_lock_identity import native_identity

spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
work = Path(spec["work"]).resolve()
owner = json.loads((work / "owned.json").read_text(encoding="utf-8"))
assert owner["nonce"] == spec["nonce"] and Path(owner["root"]).resolve() == work
assert Path(spec["store"]).resolve() == work / "store"
store = FileSessionStore(spec["store"])
identity = native_identity()
assert identity is not None and identity["pid_namespace"] is not None
memory = MemorySessionStore()
session = (
    PrismHarness(drivers={"memory": lambda: memory, "files": lambda: store},
                 stores={"ephemeral": "memory", "durable": "files"})
    .for_agent("support").for_(Participant("workers", "1")).session("shared-lock")
    if spec.get("mixedSlots") else None
)


def lock(callback, ttl=60):
    if session is not None:
        return session.lock(lambda _: callback(), ttl, spec.get("waitSeconds", 0))
    return store.with_lock(spec["lockKey"], callback, ttl, spec.get("waitSeconds", 0))


def marker_ready(name: str) -> bool:
    try:
        command = json.loads((work / name).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return False
    except PermissionError:
        # A Windows sharing denial on this owned fixture barrier is not a command.
        # Keep the original deadline; never apply this retry to production locks.
        if sys.platform != "win32":
            raise
        if spec.get("reportBarrierDenials") and not (work / "barrier-denied.json").exists():
            mark("barrier-denied.json")
        return False
    assert command["nonce"] == spec["nonce"]
    return True


def wait(name: str) -> None:
    deadline = time.monotonic() + 20
    while True:
        if spec["action"] == "hold" and marker_ready("crash.json"):
            os._exit(0)
        if marker_ready(name):
            return
        if time.monotonic() > deadline:
            raise RuntimeError("Owned test handshake timed out")
        time.sleep(0.01)


def mark(name: str) -> None:
    temporary = work / f"{name}.{os.getpid()}.tmp"
    temporary.write_text(json.dumps({"nonce": spec["nonce"], "pid": os.getpid(), "identity": identity}), encoding="utf-8")
    os.replace(temporary, work / name)


callbacks, error_code = 0, None
if spec["action"] == "index":
    mark(f"ready-{spec['worker']}.json")
    wait("go.json")
    harness = PrismHarness(drivers={"owned": lambda: store}, stores={"ephemeral": "owned", "durable": "owned"})
    for scope in [*[f"worker:{spec['worker']}:{i}" for i in range(50)], "shared"]:
        harness.for_agent("support").for_(Participant("workers", "1")).session(scope).using_mode(spec["worker"])
elif spec["action"] == "hold":
    def hold() -> None:
        mark("held.json")
        wait("release.json")
    lock(hold, spec.get("ttlSeconds", 60))
elif spec["action"] == "race":
    mark(f"started-{spec['worker']}.json")

    def race() -> None:
        global callbacks
        callbacks += 1
        with (work / "callbacks.log").open("a", encoding="utf-8") as stream:
            stream.write(spec["worker"] + "\n")
        mark(f"entered-{spec['worker']}.json")
        wait("race-release.json")

    try:
        lock(race)
    except HarnessError as error:
        if error.code != "session_locked":
            raise
        error_code = error.code
else:
    def callback() -> None:
        global callbacks
        callbacks += 1
    try:
        lock(callback)
    except HarnessError as error:
        if error.code != "session_locked":
            raise
        error_code = error.code
print(json.dumps({"action": spec["action"], "callbacks": callbacks, "error_code": error_code,
                  "identity": identity, "pid": os.getpid()}, separators=(",", ":")))
