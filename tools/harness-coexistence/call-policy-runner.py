import json
from prism_harness import ToolAuthorizer, HarnessError

result = {"refused": False, "callbacks": 0, "offered": 0, "allows_call": None, "code": None}
try:
    ToolAuthorizer(enabled=False, call=lambda *_: False)
except HarnessError as error:
    result["refused"], result["code"] = True, error.code
    result["native_error"] = {"class": type(error).__name__, "message": str(error)}
print(json.dumps(result, separators=(",", ":")))
