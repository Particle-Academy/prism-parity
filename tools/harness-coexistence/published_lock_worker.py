from __future__ import annotations

import json
import sys
from pathlib import Path

import prism_harness
from prism_harness import FileSessionStore

spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
assert Path(prism_harness.__file__).resolve().is_relative_to(Path(spec["package"]).resolve())
audit = []


def observe(event, args):
    if event in ("os.remove", "os.rename", "os.rmdir"):
        audit.append({"event": event, "path": str(args[0])})


sys.addaudithook(observe)
callbacks, failure = 0, None


def enter():
    global callbacks
    callbacks += 1


try:
    FileSessionStore(spec["store"]).with_lock(spec["key"], enter, 1, 0)
except Exception as error:
    failure = {"class": type(error).__name__, "code": getattr(error, "code", None), "message": str(error)}
print(json.dumps({"callbacks": callbacks, "failure": failure, "audit": audit}))
