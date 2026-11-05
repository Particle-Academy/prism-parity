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

Run `node tools/mcp-behavior/published.mjs` in a fresh checkout to install and verify normal Packagist PHP0.3.0, npm0.4.0 and PyPI0.3.0 consumers before executing all three native checks. The pinned released source trees are dependency-gated in CI; no checkout supplies an executing MCP SDK. `published-refs.json` binds package identities, registry integrity and every installed runtime byte (all exported files for PHP). A missing, extra or changed runtime file fails before native execution. Existing consumers are refused, so an old install cannot supply evidence for a new run.

The PHP reference and both port columns were regenerated from normal published artifacts after release verification. Inputs, independent predictions and observed values are unchanged from the candidate experiment. PHP diagnostics go to stderr and remain visible; older dependencies on newer PHP cannot corrupt the JSON observation channel. Exact hosted/current-main proof remains required for each contribution.

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
