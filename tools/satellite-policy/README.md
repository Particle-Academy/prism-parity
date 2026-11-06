This suite checks Browser policy migration and Human+ relay preflight/status
behavior. Native observations must match both PHP and separate expectations
written before the adapters ran. Checks never record or rewrite observations.

Run `node tools/satellite-policy.mjs php --check`, then repeat for `ts` and `py`.
The closed schema and semantic coverage contract are checked before SDK loading.
The fixture ships inside all three loader artifacts. A missing result, removed
family, forged agreement, unknown input or zero-work verdict fails.

Current PHP goldens were regenerated from normal published Human+ 0.6.0 and
Browser 0.4.1 with zero disagreements against the independent predictions.
All 232 inputs and expected values remain unchanged. `published-refs.json`
records the reviewed releases and immutable source revisions for all languages.

Run `node tools/satellite-policy/published.mjs` to create fresh normal Composer,
npm and PyPI consumers, compare every SDK runtime file with the reviewed source
checkouts, and execute all three native observers against installed artifacts.
The default source checkouts are siblings of this repository; an operator may
provide `--source-root <directory>` for a separate collection of reviewed
checkouts. Source paths verify provenance and never replace installed runtimes.
The three-OS CI job builds the reviewed TypeScript source before comparison.
Only CRLF/LF differences in source text are normalized and reported; installed
runtime hashes must remain unchanged across all 696 observations.

The original `candidate-refs.json` and candidate runner retain the historical
source checkpoint. Their output is explicitly candidate evidence. Published
checks have a separate disposable directory and report; an existing directory,
wrong source, missing package, unreviewed version or independent difference
fails. Source, hosted, actual-main and published-artifact proof remain separate.

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

Compatibility census for corpus 0.1.21: separate normal checkout-based loader
installs of reviewed main 0.1.20 and candidate 0.1.21 expose the same IDs, parsed
case values and skip states for all 34 existing suites in each language. The
35th suite is satellite-policy with 232 cases in every language. This is a
reviewed-source compatibility measurement, not an unpublished registry claim.
After canonical 0.1.21 reaches main, the core-port follow-up must measure that
actual main through installed loaders and update only its reviewed finite
version census; unreviewed future versions must continue to be rejected.
