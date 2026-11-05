The MCP behavior corpus executes native SDK boundaries against injected protocol
replies. It covers early trust, distinct empty/missing refusal, default UTF-8
result bounds, omission markers, strict failure flags, named annotation refusal,
wildcard exclusions and native missing-name warnings. `result` columns are native
execution output. `prediction` is a separate prewritten expectation; agreement
cannot override a failed prediction.

Run `node tools/mcp-behavior.mjs php --check`, then repeat with `ts` and `py`.
The entry point validates the closed schema and semantic contract before loading
the SDK, rejects empty/missing/duplicate observations, and never records or
rewrites a result. Loaders carry their own fixture copies.

Set `PRISM_MCP_AUTOLOAD` to a verified PHP MCP installation's autoloader.
`PRISM_MCP_TS_DIST` can name a TypeScript build; its default is the sibling
`prism-mcp-ts/dist/index.js`. Python imports installed `prism_mcp`, or an explicitly
chosen local source through `PRISM_MCP_PY_SRC`. Interpreter overrides are
`PRISM_MCP_PHP_BINARY` and `PRISM_MCP_PY_BINARY`. These are trusted operator
choices, never values taken from MCP responses or fixtures.

The draft contribution currently records candidate-source observations. Its
candidate CI job pins all three reviewed commits and does not establish a normal
published-reference golden. Package source merges, Wish's release approval,
normal PHP/port artifact verification, regeneration from the released PHP
reference and replacing candidate wiring remain gates before canonical merge
and published alignment closure.

PHP's adapter substitutes only protocol replies: real PendingConnection trust,
Client hydration and RemoteTool/ResultGuard execute. The public PHP Tool prefix
is normalized for comparison. PHP refuses stray HTTP, TypeScript refuses fetch,
and Python fences DNS/connect after the native event loop initializes. Input is
UTF-8 JSON bytes on every platform. Original probe decoding failures are retained
in the review evidence, with no change to SDK expectations.

Callback identity/cancellation, frozen diagnostic events and exclusion reset
also require the package-native tests. G132 raw header value encoding, new
transport/cache implementations, provider execution, G43 and G125 are outside
this suite.
