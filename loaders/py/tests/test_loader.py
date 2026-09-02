"""Loader guards, exercised against the SHIPPED corpus.

Every assertion below runs against the corpus this package ships, or against a
copy of it that has been deliberately corrupted. None of them run against
hand-written example rows.

That rule has teeth. A loader can assert something the reference language cannot
express, and no amount of green ticks will surface it. Both directions are live
for us:

  - PHP is our reference and has ONE absent value, while Python has None and
    TypeScript has null AND undefined. A guard invented in a port's loader could
    demand a distinction no PHP-authored golden can state.
  - PHP also cannot distinguish an empty JSON array from an empty JSON object
    once decoded, so a PHP-authored golden cannot be authoritative about
    container type. See docs/decisions/0007-reference-language-limits.md.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from prism_conformance import LANGUAGES, Corpus, CorpusError, compare, discover_root


def _plain_copy(tmp_path: Path) -> Path:
    """A byte-for-byte copy, with nothing re-serialized.

    ``_corrupted`` rewrites cases.json through ``json.dumps`` even when the
    mutation is a no-op, and that rewrite changes the bytes -- which the digest
    correctly notices.
    """
    root = tmp_path / "copy"
    shutil.copytree(discover_root(), root)

    return root


def _corrupted(tmp_path: Path, mutate: Callable[[dict[str, Any]], None]) -> Path:
    root = tmp_path / "corpus"
    shutil.copytree(discover_root(), root)

    cases_path = root / "suites" / "openai-text-request" / "cases.json"
    document = json.loads(cases_path.read_text(encoding="utf-8"))
    mutate(document)
    cases_path.write_text(json.dumps(document, indent=4, ensure_ascii=False), encoding="utf-8")

    return root


def _expect_load_error(tmp_path: Path, code: str, mutate: Callable[[dict[str, Any]], None]) -> None:
    root = _corrupted(tmp_path, mutate)

    with pytest.raises(CorpusError) as excinfo:
        Corpus.open(root).suite("openai-text-request")

    assert excinfo.value.code == code


def test_shipped_corpus_loads() -> None:
    corpus = Corpus.open()

    assert corpus.version.count(".") == 2
    assert corpus.suite_ids()

    for suite_id in corpus.suite_ids():
        suite = corpus.suite(suite_id)
        assert suite.manifest["id"] == suite_id
        assert suite.cases("py")


def test_duplicate_case_id_is_a_load_error(tmp_path: Path) -> None:
    _expect_load_error(tmp_path, "duplicate_case_id", lambda doc: doc["cases"].append(dict(doc["cases"][0])))


def test_case_ids_must_ascend_within_their_family(tmp_path: Path) -> None:
    """Two `trq-` rows swapped. The rule still bites inside one family."""

    def swap(doc: dict[str, Any]) -> None:
        doc["cases"][0], doc["cases"][1] = doc["cases"][1], doc["cases"][0]

    _expect_load_error(tmp_path, "unsorted_case_ids", swap)


def test_separate_families_need_not_ascend_between_them(tmp_path: Path) -> None:
    """The permission this rule grants, pinned rather than merely allowed.

    A suite may group its cases by what they probe -- `workspace-path-guard`
    runs eight hazard families and reads as eight blocks. Interleaving them, or
    starting a lower-sorting family after a higher one, is legal because the
    renumbering hazard the rule guards is entirely within a family.

    Without this test the loosening would be invisible: every existing case
    would still pass under the OLD global rule too, so nothing would fail if
    someone tightened it back.
    """
    root = _corrupted(
        tmp_path,
        lambda doc: doc["cases"].extend(
            [
                {**doc["cases"][0], "id": "aaa-0001"},
                {**doc["cases"][0], "id": "zzz-0001"},
                {**doc["cases"][0], "id": "aaa-0002"},
            ]
        ),
    )

    suite = Corpus.open(root).suite("openai-text-request")

    assert [case["id"] for case in suite.cases("php")][-3:] == ["aaa-0001", "zzz-0001", "aaa-0002"]


def test_a_family_that_goes_backwards_is_still_a_load_error(tmp_path: Path) -> None:
    """`aaa-0002` then `aaa-0001`, with another family in between.

    The interleaving must not become a way to smuggle a descending id past the
    check -- which is the failure a naive "reset the previous id when the family
    changes" implementation would have.
    """

    def descend(doc: dict[str, Any]) -> None:
        doc["cases"].extend(
            [
                {**doc["cases"][0], "id": "aaa-0002"},
                {**doc["cases"][0], "id": "zzz-0001"},
                {**doc["cases"][0], "id": "aaa-0001"},
            ]
        )

    _expect_load_error(tmp_path, "unsorted_case_ids", descend)


def test_case_without_notes_is_a_load_error(tmp_path: Path) -> None:
    def blank(doc: dict[str, Any]) -> None:
        doc["cases"][0]["notes"] = "   "

    _expect_load_error(tmp_path, "missing_case_notes", blank)


def test_case_without_since_is_a_load_error(tmp_path: Path) -> None:
    def drop(doc: dict[str, Any]) -> None:
        del doc["cases"][0]["since"]

    _expect_load_error(tmp_path, "missing_case_since", drop)


# The skip guard, pinned from BOTH directions.
def test_scalar_skip_is_a_load_error(tmp_path: Path) -> None:
    def scalar(doc: dict[str, Any]) -> None:
        doc["cases"][0]["skip"] = True

    _expect_load_error(tmp_path, "skip_must_be_a_map", scalar)


def test_list_skip_is_a_load_error(tmp_path: Path) -> None:
    def listed(doc: dict[str, Any]) -> None:
        doc["cases"][0]["skip"] = ["php"]

    _expect_load_error(tmp_path, "skip_must_be_a_map", listed)


def test_blank_skip_reason_is_a_load_error(tmp_path: Path) -> None:
    def blank(doc: dict[str, Any]) -> None:
        doc["cases"][0]["skip"] = {"php": ""}

    _expect_load_error(tmp_path, "blank_skip_reason", blank)


def test_unknown_skip_language_is_a_load_error(tmp_path: Path) -> None:
    def unknown(doc: dict[str, Any]) -> None:
        doc["cases"][0]["skip"] = {"rust": "no rust port exists yet"}

    _expect_load_error(tmp_path, "unknown_skip_language", unknown)


def test_a_skip_applies_to_its_own_language_only() -> None:
    suite = Corpus.open().suite("openai-text-request")

    # trq-0025 is skipped for Python and nothing else. A loader that read the
    # skip map as a truthy scalar would report this row skipped everywhere.
    in_python = next(case for case in suite.cases("py") if case["id"] == "trq-0025")
    in_typescript = next(case for case in suite.cases("ts") if case["id"] == "trq-0025")
    in_php = next(case for case in suite.cases("php") if case["id"] == "trq-0025")

    assert in_python["skipped"] is True
    assert in_python["skip_reason"]
    assert in_typescript["skipped"] is False
    assert in_typescript["skip_reason"] is None
    assert in_php["skipped"] is False


def test_skipped_rows_are_returned_not_filtered() -> None:
    suite = Corpus.open().suite("openai-text-request")

    assert len(suite.cases("py")) == len(suite.cases("ts"))
    assert "trq-0025" in suite.skipped_ids("py")
    assert "trq-0025" not in suite.skipped_ids("ts")


def test_unknown_language_is_rejected() -> None:
    with pytest.raises(CorpusError) as excinfo:
        Corpus.open().suite("openai-text-request").cases("rust")

    assert excinfo.value.code == "unknown_language"


def test_root_without_version_reports_corpus_not_installed(tmp_path: Path) -> None:
    with pytest.raises(CorpusError) as excinfo:
        Corpus.open(tmp_path)

    assert excinfo.value.code == "corpus_not_installed"


def test_comparator_accepts_every_shipped_golden_and_rejects_a_byte_change() -> None:
    """Exercised against every golden the corpus ships, never against invented pairs.

    The verdicts are judged with plain ``is``/``==``, NOT with ``compare`` -- using
    a comparator to judge its own output is circular, and a broken comparator
    could pass its own table.
    """
    corpus = Corpus.open()
    checked = 0

    for suite_id in corpus.suite_ids():
        for case in corpus.suite(suite_id).cases("py"):
            # A `security-corpus` row has no `expect` at all: it records what
            # each language PRODUCED, per language, rather than one golden the
            # others must match. There is nothing for the comparator to check on
            # those, and the `checked` floor below is what stops this skip from
            # quietly turning the whole test into a no-op.
            golden = next(
                (value for value in case.get("expect", {}).values() if isinstance(value, str)),
                None,
            )
            if golden is None:
                continue

            tolerance = case.get("tolerance")
            assert compare(golden, golden, tolerance) is True, case["id"]
            assert compare(golden, golden + " ", tolerance) is False, case["id"]
            checked += 1

    assert checked >= 40, f"expected the corpus to carry goldens, checked {checked}"


def test_no_shipped_case_declares_a_tolerance() -> None:
    corpus = Corpus.open()

    for suite_id in corpus.suite_ids():
        for case in corpus.suite(suite_id).cases("py"):
            assert case.get("tolerance") is None, (
                f"{case['id']} declares a tolerance; if that is deliberate, "
                "TEST the justification before relying on it"
            )


def test_every_known_language_can_be_asked_for() -> None:
    corpus = Corpus.open()

    for language in LANGUAGES:
        assert isinstance(corpus.suite("openai-text-request").cases(language), list)


def test_probe_expectations_subtract_skipped_cases() -> None:
    corpus = Corpus.open()

    for_python = corpus.expected_probe_failures("omit-null-keys", "py")
    for_typescript = corpus.expected_probe_failures("omit-null-keys", "ts")

    assert "trq-0025" in for_typescript["openai-text-request"]
    assert "trq-0025" not in for_python["openai-text-request"]


# The digest exists because a VERSION number cannot tell you whether two runners
# are reading the same bytes. It is compared across languages by
# scripts/cross-check.mjs, so it is pinned here from four directions: stable,
# sensitive to a single byte, refusing to hash nothing, and agreeing with the
# TypeScript loader.
def test_digest_is_stable_and_well_formed() -> None:
    corpus = Corpus.open()
    digest = corpus.digest()

    assert digest.startswith("sha256:")
    assert len(digest) == len("sha256:") + 64
    assert all(character in "0123456789abcdef" for character in digest[7:])
    assert corpus.digest() == digest
    assert Corpus.open().digest() == digest


def test_changing_one_byte_changes_the_digest(tmp_path: Path) -> None:
    def touch(document: dict[str, Any]) -> None:
        document["cases"][0]["title"] += "."

    root = _corrupted(tmp_path, touch)

    # Judged with plain string equality, never with the loader's own compare --
    # using a comparator to judge its own inputs is circular.
    assert Corpus.open(root).digest() != Corpus.open().digest()


def test_byte_for_byte_copy_digests_identically(tmp_path: Path) -> None:
    assert Corpus.open(_plain_copy(tmp_path)).digest() == Corpus.open().digest()


def test_digesting_an_empty_corpus_fails_rather_than_hashing_nothing(tmp_path: Path) -> None:
    root = _plain_copy(tmp_path)

    # Opened while the fixtures are still present, then emptied: the digest is
    # lazy, so this exercises the vacuity guard rather than the open guard.
    corpus = Corpus.open(root)

    shutil.rmtree(root / "suites")
    shutil.rmtree(root / "probes", ignore_errors=True)
    (root / "VERSION").unlink()

    assert not (root / "suites").exists()

    with pytest.raises(CorpusError) as excinfo:
        corpus.digest()

    assert excinfo.value.code == "corpus_not_installed"


def test_digest_agrees_with_the_typescript_loader() -> None:
    """The whole point of the digest is cross-language agreement, so assert it.

    A skip here would hide exactly the disagreement the digest exists to detect,
    so a missing toolchain fails the test instead.
    """
    node = shutil.which("node")
    assert node is not None, "node is required: this test asserts the digest agrees across languages"

    root = discover_root()
    ts_loader = _find_typescript_loader()

    script = (
        f"import {{ Corpus }} from {json.dumps(ts_loader.as_uri())};"
        "console.log(Corpus.open(process.env.PRISM_CORPUS_ROOT).digest());"
    )

    completed = subprocess.run(  # noqa: S603
        [node, "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        env={**os.environ, "PRISM_CORPUS_ROOT": str(root)},
        check=False,
    )

    assert completed.returncode == 0, f"node failed: {completed.stderr}"
    assert completed.stdout.strip() == Corpus.open(root).digest()


def _find_typescript_loader() -> Path:
    for candidate in [discover_root(), *discover_root().parents]:
        loader = candidate / "loaders" / "ts" / "src" / "index.js"
        if loader.is_file():
            return loader

    raise AssertionError(
        "could not find loaders/ts/src/index.js: the cross-language digest check needs the prism-parity checkout"
    )


def test_every_probe_names_only_real_suites_and_cases() -> None:
    corpus = Corpus.open()
    probes = corpus.probes()["probes"]

    assert any(probe["kind"] == "control" for probe in probes), "the corpus must ship a control probe"

    for probe in probes:
        for suite_id, ids in (probe.get("must_fail") or {}).items():
            known = {case["id"] for case in corpus.suite(suite_id).cases("py")}

            for case_id in ids:
                assert case_id in known, f"probe {probe['id']} names {case_id}, which is not in {suite_id}"
