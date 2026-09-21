"""Is every installing job actually blocked by the allowlist check?

Blocked means: the check runs earlier in the SAME job, or the gate is anywhere
upstream in the `needs:` graph. `needs` is transitive in Actions — a job cannot
start until everything upstream has succeeded — so walking one edge measures a
proxy (the direct edge) for the property in question (is a gate upstream at
all). fancy's detector had that bug and nearly "fixed" a job that was already
correct; this one does the closure.

Matches `third-party/check.mjs`, not `check.mjs`: an earlier version of this
script matched the substring and counted `tools/parity-check.mjs` and
`tools/factcheck.mjs` as allowlist gates, reporting three ungated jobs in
prism-parity as covered.

Both bugs are the same shape as the thing this script exists to find: a detector
aimed at a proxy for the property, reporting confidently on a question it was
not asking.
"""

import io
import os
import sys

import yaml

# The envelope's repos/ directory: this file lives at <envelope>/repos/
# prism-parity/tools/, so three levels up is repos/. Overridable, because a
# checkout that is not inside an envelope is a legitimate way to run this.
ROOT = os.environ.get(
    "PRISM_REPOS",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
)
INSTALLS = ("npm ci", "npm install", "composer install", "composer update", "pip install")

# AN INSTALL IS NOT ALWAYS A `run:` COMMAND. `ramsey/composer-install` resolves
# and installs the whole dependency tree, and a detector that only reads `run:`
# strings cannot see it — which is how 27 ungated jobs in this estate passed two
# independent audits, ours and the org's, both reporting green.
#
# The step TYPE is not what a step does. That is the same proxy error as reading
# a filename, a path or a substring, and it is the one that fails silent in both
# directions: nobody investigates a clean report.
INSTALL_ACTIONS = ("ramsey/composer-install",)


def executable(step: dict) -> str:
    """The lines of a step's `run:` the runner will actually execute.

    WHOLE-LINE COMMENTS ARE STRIPPED FIRST. fancy's detector read a comment as
    behaviour and reported a correctly-gated job as ungated — and the comment
    that broke it was the one documenting the gate. Prose beside a check has
    always been "not the check"; it turns out it can be worse than inert. It can
    be INPUT.

    Both directions matter and the second is the dangerous one. A comment
    mentioning an install raises a false alarm, which someone investigates. A
    COMMENTED-OUT GATE read as a gate reports an ungated job as blocked — this
    file's own failure mode, a check examining something that is not there and
    rendering green.
    """
    lines = str(step.get("run", "")).split("\n")

    return "\n".join(line for line in lines if not line.lstrip().startswith("#"))


def runs_install(step: dict) -> bool:
    if any(action in str(step.get("uses", "")) for action in INSTALL_ACTIONS):
        return True

    return any(marker in executable(step) for marker in INSTALLS)


def runs_check(step: dict) -> bool:
    return "third-party/check.mjs" in executable(step)


def needs_of(job: dict) -> list[str]:
    needs = job.get("needs") or []
    return [needs] if isinstance(needs, str) else list(needs)


def reaches_gate(jid: str, jobs: dict, gates: set[str], seen: set[str] | None = None) -> bool:
    """Is a gating job anywhere upstream of `jid`? Cycle-safe."""
    seen = seen if seen is not None else set()

    for parent in needs_of(jobs.get(jid) or {}):
        if parent in seen:
            continue

        seen.add(parent)

        if parent in gates or reaches_gate(parent, jobs, gates, seen):
            return True

    return False


def audit() -> int:
    blocked, unblocked, examined = 0, [], 0

    if not os.path.isdir(ROOT):
        print(f"FAIL: {ROOT} is not a directory, so nothing was examined.")
        print("Set PRISM_REPOS to the envelope's repos/ directory.")
        return 2

    for repo in sorted(os.listdir(ROOT)):
        wf_dir = os.path.join(ROOT, repo, ".github", "workflows")

        if not os.path.isdir(wf_dir):
            continue

        for name in sorted(os.listdir(wf_dir)):
            if not name.endswith((".yml", ".yaml")):
                continue

            path = os.path.join(wf_dir, name)
            examined += 1

            try:
                doc = yaml.safe_load(io.open(path, encoding="utf-8"))
            except Exception as error:  # a workflow we cannot read is not a pass
                unblocked.append((repo, name, "?", f"unparseable: {error}"))
                continue

            if not isinstance(doc, dict):
                continue

            jobs = doc.get("jobs") or {}
            gates = {j for j, v in jobs.items() if any(runs_check(s) for s in (v.get("steps") or []))}

            for jid, job in jobs.items():
                steps = job.get("steps") or []
                first = next((i for i, s in enumerate(steps) if runs_install(s)), None)

                if first is None:
                    continue

                if any(runs_check(s) for s in steps[:first]) or reaches_gate(jid, jobs, gates):
                    blocked += 1
                else:
                    why = "check in a parallel job" if gates else "no check in this file"
                    unblocked.append((repo, name, jid, why))

    # SCOPE BEFORE VERDICT. A scan that examined nothing reports no offenders,
    # which is indistinguishable from a clean estate — the failure fancy found
    # in the org's nightly audit, where a token that silently omitted private
    # repos returned 200 and reported everything fine. Zero examined is a
    # failure here, not a pass.
    if examined == 0:
        print(f"FAIL: no workflow files found under {ROOT}, so nothing was checked.")
        print("A scan that examines nothing reports no offenders. That is not a clean estate.")
        return 2

    print(f"workflow files examined           {examined}")
    print(f"install is BLOCKED by the check   {blocked} job(s)")
    print(f"install runs before/beside it     {len(unblocked)} job(s)")

    if unblocked:
        print()
        for repo, wf, jid, why in unblocked:
            print(f"  {repo:24} {wf:20} job={jid:16} {why}")

    return 1 if unblocked else 0


# The control. A detector that matches nothing and a detector aimed at the wrong
# thing both report zero, so prove it can still see one before trusting a clean
# run. fancy's estate scan did this; the first version of this script did not,
# and was wrong for three jobs.
def self_test() -> None:
    jobs = {
        "allowlist": {"steps": [{"run": "node .x/third-party/check.mjs --repo ."}]},
        "middle": {"needs": "allowlist", "steps": []},
        "far": {"needs": ["middle"], "steps": [{"run": "npm ci"}]},
        "orphan": {"steps": [{"run": "npm ci"}]},
    }
    gates = {"allowlist"}

    assert reaches_gate("far", jobs, gates), "transitive needs must count as blocked"
    assert not reaches_gate("orphan", jobs, gates), "a job with no needs is not blocked"
    assert not reaches_gate("allowlist", jobs, gates), "the gate does not gate itself"

    cyclic = {"a": {"needs": "b", "steps": []}, "b": {"needs": "a", "steps": []}}
    assert not reaches_gate("a", cyclic, gates), "a cycle must terminate"

    # A file says what it does in two registers and only one of them runs.
    assert not runs_install({"run": "# npm ci is done above\nnpm run build"}), (
        "a comment mentioning an install is not an install"
    )
    assert not runs_check({"run": "# node x/third-party/check.mjs --repo .\necho skip"}), (
        "a commented-out gate is not a gate"
    )
    assert runs_install({"run": "npm ci"}), "a real install must still be seen"
    assert runs_install({"uses": "ramsey/composer-install@v3"}), (
        "an install performed by an ACTION is still an install"
    )
    assert not runs_install({"uses": "actions/checkout@v4"}), (
        "checking out a repository is not installing its dependencies"
    )
    assert runs_check({"run": "node x/third-party/check.mjs --repo ."}), (
        "a real gate must still be seen"
    )

    print(
        "self-test: fires on transitive, ignores orphan, survives a cycle, "
        "reads code not comments\n"
    )


self_test()
sys.exit(audit())
