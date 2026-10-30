"""Extract only regular files from verified archives into a new owned root."""
import hashlib
import json
import sys
import tarfile
import zipfile
from pathlib import Path, PurePosixPath
archive, destination, kind = sys.argv[1:]
root = Path(destination).resolve()
assert not root.exists()
root.mkdir()
files = {}
def write(name, data):
    parts = PurePosixPath(name).parts
    assert parts and all(p not in ("..", ".", "") and ":" not in p for p in parts)
    assert not name.startswith(("/", "\\")) and "\\" not in name
    target = root.joinpath(*parts).resolve()
    assert target.is_relative_to(root) and len(data) < 10_000_000
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as stream: stream.write(data)
    files[name] = hashlib.sha256(data).hexdigest()
if kind == "ts":
    with tarfile.open(archive) as source:
        for member in source:
            if member.isdir(): continue
            assert member.isfile() and member.name.startswith("package/")
            stream = source.extractfile(member)
            assert stream is not None
            write(member.name, stream.read())
else:
    assert kind == "py"
    with zipfile.ZipFile(archive) as source:
        for member in source.infolist():
            if member.is_dir(): continue
            assert (member.external_attr >> 16) & 0o170000 in (0, 0o100000)
            write(member.filename, source.read(member))
print(json.dumps({"files": files}))
