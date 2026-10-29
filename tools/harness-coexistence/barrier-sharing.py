"""Force a real Windows barrier sharing denial; no production lock is modified."""
import ctypes
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
from ctypes import wintypes

assert sys.platform == "win32"
work = Path(tempfile.mkdtemp(prefix="barrier-sharing-", dir=sys.argv[1]))
(work / "store").mkdir()
nonce = secrets.token_hex(16)
(work / "owned.json").write_text(json.dumps({"root": str(work), "nonce": nonce}))
spec = {"work": str(work), "store": str(work / "store"), "nonce": nonce, "action": "hold", "lockKey": "sharing-control", "ttlSeconds": 60, "reportBarrierDenials": True}
(work / "spec.json").write_text(json.dumps(spec))
child = subprocess.Popen([sys.executable, str(Path(__file__).with_name("index-worker.py")), str(work / "spec.json")], env=os.environ.copy(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, creationflags=0x08000000)
deadline = time.monotonic() + 20
while not (work / "held.json").exists():
    assert child.poll() is None
    assert time.monotonic() < deadline
    time.sleep(0.01)
assert json.loads((work / "held.json").read_text())["nonce"] == nonce
kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
kernel.CreateFileW.restype = wintypes.HANDLE
kernel.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
kernel.WriteFile.restype = wintypes.BOOL
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.CloseHandle.restype = wintypes.BOOL
path = work / "release.json"
handle = kernel.CreateFileW(str(path), 0x40000000, 0, None, 1, 0x80, None)
assert handle != ctypes.c_void_p(-1).value
try:
    data = json.dumps({"nonce": nonce}).encode()
    buffer = ctypes.create_string_buffer(data)
    written = wintypes.DWORD()
    assert kernel.WriteFile(handle, buffer, len(data), ctypes.byref(written), None)
    assert written.value == len(data)
    try:
        path.read_text()
    except PermissionError:
        denied = True
    else:
        raise AssertionError("The control must cause an actual sharing denial")
    deadline = time.monotonic() + 5
    while not (work / "barrier-denied.json").exists():
        assert child.poll() is None
        assert time.monotonic() < deadline
        time.sleep(0.01)
    assert json.loads((work / "barrier-denied.json").read_text())["nonce"] == nonce
    assert child.poll() is None
finally:
    assert kernel.CloseHandle(handle)
stdout, stderr = child.communicate(timeout=20)
assert child.returncode == 0, stderr
assert json.loads(stdout)["action"] == "hold"
assert json.loads(path.read_text())["nonce"] == nonce
print(json.dumps({"status": "PASS", "actualSharingDenial": denied, "workerDeniedBarrierRead": True, "childAliveWhileDenied": True, "nonceValidatedAfterClose": True, "exit": child.returncode}))
