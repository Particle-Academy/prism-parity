"""Native directory-to-regular-file primitive; owned fixtures only."""
import json
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
root.mkdir()
owned = root.resolve(strict=True)
source, target = root / "candidate", root / "legacy.lock"
source.mkdir()
(source / "owner-new.json").write_text("new\n", encoding="utf-8")
target.write_text("legacy\n", encoding="utf-8")
assert source.parent.resolve(strict=True) == owned
assert target.parent.resolve(strict=True) == owned
error = None
try:
    os.rename(source, target)
except OSError as failure:
    error = {"errno": failure.errno, "type": type(failure).__name__}
assert error is not None, "Python must refuse directory -> existing regular file"
assert target.is_file() and target.read_text(encoding="utf-8") == "legacy\n"
assert (source / "owner-new.json").read_text(encoding="utf-8") == "new\n"
print(json.dumps({"platform": sys.platform, "regular_file_target": "refused-original-intact",
                  "error": error, "fixture": str(root)}))

