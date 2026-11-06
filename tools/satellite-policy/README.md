This suite checks Browser policy migration and Human+ relay preflight/status
behavior. Native observations must match both PHP and separate expectations
written before the adapters ran. Checks never record or rewrite observations.

Run `node tools/satellite-policy.mjs php --check`, then repeat for `ts` and `py`.
The closed schema and semantic coverage contract are checked before SDK loading.
The fixture ships inside all three loader artifacts. A missing result, removed
family, forged agreement, unknown input or zero-work verdict fails.

Current observations are **candidate-source evidence**. Exact package revisions
are in `candidate-refs.json`; the unchanged PHP Browser reference was normally
installed. Human+ PHP must be regenerated from a normally published package,
with independently verified runtime identity, before final canonical merge.
Source, hosted, actual-main and published-artifact evidence are separate gates.

Trusted operator paths are `PRISM_POLICY_BROWSER_AUTOLOAD` and
`PRISM_POLICY_HUMAN_AUTOLOAD`, `PRISM_POLICY_BROWSER_TS_DIST` and
`PRISM_POLICY_HUMAN_TS_DIST`, and `PRISM_POLICY_BROWSER_PY_SRC` and
`PRISM_POLICY_HUMAN_PY_SRC`. Interpreter overrides are
`PRISM_POLICY_PHP_BINARY` and `PRISM_POLICY_PY_BINARY`. Fixtures cannot provide
paths, executable arguments or environment overrides.

PHP runs its real Browser manager, relay classifier, Guzzle transport and native
concurrent cURL. The concurrent cases use a bounded disposable loopback server
and child process; child output goes through temporary files to avoid blocking
Windows pipes. TypeScript and Python execute their sequential exchange bindings
with controlled HTTP replies. Public outcomes are compared; binding-specific
connection ordering is kept in native tests. Classifier acceptance of HTTP204
does not assert that a response body exists.

Controlled native resolver APIs supply failed, empty, mixed, public and
changing answers. All-record preflight runs before each HTTP leg. No real DNS,
provider or remote HTTP traffic is needed. Literal allowlists include only the
input spelling and the native URL parser's equivalent literal spelling.

The existing trusted-proxy requirement remains the connection boundary. These
checks establish preflight behavior and make no connection-pinning or resolver
deadline claim. Explicit isolated local/unverified modes are tested honestly.
Callback/owner/confirmation policy, provider execution and other transport
contracts remain outside this slice. Package-native regressions and production
mutation controls are required in addition to corpus agreement.
