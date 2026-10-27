This suite executes one controlled model step through each published harness runtime,
then records an explicit approval and resumes it. It measures model calls, tool
invocations, step/cost retention, pending approval authority, and caller failure.

The PHP runner uses Testbench with an explicitly asserted SQLite `:memory:` database.
Its provider double drives the real pending request and stream collector. The ports
use their public client callback seam. Successful Stop rows remain completed.
PHP-specific rows also exercise recoverable error then Stop, missing final usage,
and the original failure after already answered tools.

The shared result projects PHP's existing `status=failed` plus bounded
`Error`/`Unknown` reason to `model_step_failed`. PHP receives no new native error code.
Both ports must expose that code directly with the same bounded reason. The native
columns retain the actual vocabulary, package version, cost and settlement outcome.

| Native path | Recorded failed-step cost in this synthetic fixture | Settlement outcome |
|---|---|---|
| PHP text/structured | 0.04 | Existing `completed` accounting outcome |
| PHP failed stream | Reserved maximum 0.10 | `failed` |
| TypeScript/Python client | Reported 0.04 | No PHP settlement callback |

Those differences are preserved. The common cost assertion asks whether each runtime
retained its existing accounting policy. A subsequent explicit turn may make a new
model call; it must execute zero calls from the failed response. Existing answered
results are retained, and no rollback of earlier side effects is implied.

CI installs the exact declared registry versions and runs:

```sh
node tools/run-gate.mjs failedSteps -- node tools/failed-step-corpus.mjs
```

`--record` writes execution results only after every language satisfies the independent
safety contract and reports the required published release version. `--development`
checks candidate runtimes without writing goldens and cannot be combined with
`--record`. Original pre-fix regressions are preserved in the G153 evidence. Native
stream-frame equality and the G125 trace disagreement remain outside this projection.
