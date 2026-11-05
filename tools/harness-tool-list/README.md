# Tool-list mode ceiling

The corpus records actual turn entry points: PHP `Session::send()` and
`Session::stream()`; TypeScript `AgentRuntime.send()` and `sendStructured()`;
Python `AgentRuntime.send()` and `send_structured()`. Neither port has a harness
stream API. No stream equivalence is claimed.

PHP goldens were recorded from a normal Packagist installation of
`particle-academy/prism-harness:0.22.2`. The PHP fixture uses Testbench with
environment-file loading disabled and a private SQLite `:memory:` connection
configured before migrations. It never sets database environment variables.
The model client is Prism's native fake; tool handlers must never execute.

Run the reference fixture with the installed package's PHPUnit and autoloader:

```sh
php /path/to/reference/vendor/bin/phpunit --no-configuration \
  --bootstrap /path/to/reference/vendor/autoload.php \
  tools/harness-tool-list/ToolListReferenceTest.php
```

`PRISM_TOOL_LIST_CASES` can select the input document. Setting
`PRISM_TOOL_LIST_OUTPUT` records native JSONL observations; otherwise the test
compares against the recorded PHP column. Independent authority expectations
run in both modes. The existing three-OS harness workflow also checks this
contract against its separately pinned PHP source, without changing those pins.

The ports vendor `cases.json` and execute their own native entry tests. Optional
`PRISM_TOOL_LIST_RECORDING` writes their observations for reviewed regeneration.
Ordinary tests compare the actual observation with their recorded language
column and the independently prewritten expectation.

PHP legacy sessions filter foreign requested names; the ports retain the typed
`tool_not_available` refusal approved by the maintainer. Those native outcomes
remain different. Named sessions refuse foreign names in all three languages.
The ceiling and authorization properties do not establish that an offered tool
is safe to invoke. G125 and other harness default changes remain separate.
