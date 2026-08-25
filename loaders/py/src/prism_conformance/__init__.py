"""The prism-parity conformance corpus and its Python loader.

Deliberately the same API shape as the PHP and TypeScript loaders. Three loaders
that drifted into three shapes would be three contracts, and the point of
publishing a loader at all is that consumers stop writing their own -- four of
them elsewhere did, and two of those copies shared a silent bug: they read a
per-language skip as a truthy scalar, which skipped every language at once AND
made the blank-reason guard unreachable, because a non-empty mapping is never
blank. Both effects were invisible and both builds stayed green.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

__all__ = [
    "LANGUAGES",
    "Corpus",
    "CorpusError",
    "Suite",
    "compare",
    "discover_root",
]

LANGUAGES: tuple[str, ...] = ("php", "ts", "py")


class CorpusError(Exception):
    """Every load-time guard raises this, and every guard has a CODE.

    The code is the contract; the sentence is not. The three loaders word these
    differently on purpose -- a test that pins the prose holds every
    implementation to a translation and goes red on a wording improvement that
    changed nothing.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def compare(expected: str, actual: str, tolerance: float | None = None) -> bool:
    """Compare a golden against a produced value.

    The corpus has exactly one comparison mode: the canonical JSON string. There
    is deliberately no global float epsilon. A global tolerance is invisible --
    nobody reading a fixture can tell whether it asserts a value or a
    neighbourhood -- and an invisible one lets two implementations that computed
    DIFFERENT values pass as equal, in the package whose product is catching
    exactly that. A row that genuinely needs slack declares ``tolerance`` on
    itself, where a reader can see it. No row in the corpus needs one today.
    """
    if tolerance is None:
        return expected == actual

    return _within_tolerance(_safe_parse(expected), _safe_parse(actual), tolerance)


def _safe_parse(value: str) -> Any:
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return value


def _within_tolerance(expected: Any, actual: Any, tolerance: float) -> bool:
    if isinstance(expected, bool) or isinstance(actual, bool):
        return expected is actual

    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return abs(expected - actual) <= tolerance

    if isinstance(expected, list) and isinstance(actual, list):
        return len(expected) == len(actual) and all(
            # strict=True never raises here: the length check short-circuits first.
            _within_tolerance(a, b, tolerance)
            for a, b in zip(expected, actual, strict=True)
        )

    if isinstance(expected, dict) and isinstance(actual, dict):
        # Key ORDER is part of what the corpus pins, so it is compared even on
        # the tolerance path.
        return list(expected.keys()) == list(actual.keys()) and all(
            _within_tolerance(expected[key], actual[key], tolerance) for key in expected
        )

    return bool(expected == actual)


def discover_root(start: Path | None = None) -> Path:
    """Walk UP from ``start`` until a directory containing ``suites/`` is found.

    Never a fixed ``../..`` and never a sibling checkout: a hard-coded relative
    path works in exactly one directory layout and silently no-ops in every
    other, including CI, which checks out one repo. Because the fixtures ship
    inside this package, the walk lands on the package root when installed and
    on the repo root when developing here.
    """
    current = (start or Path(__file__).resolve().parent).resolve()

    while True:
        if (current / "suites").is_dir():
            return current

        if current.parent == current:
            raise CorpusError(
                "corpus_not_installed",
                "Walked to the filesystem root without finding a directory containing suites/.",
            )

        current = current.parent


@dataclass(frozen=True)
class Suite:
    id: str
    manifest: dict[str, Any]
    _cases: list[dict[str, Any]] = field(repr=False)

    def cases(self, language: str) -> list[dict[str, Any]]:
        """Rows for one language, each annotated with whether it is skipped and why.

        Skipped rows are RETURNED rather than filtered out, so a runner reports
        them and a skip stays visible instead of quietly shrinking the suite.
        """
        if language not in LANGUAGES:
            raise CorpusError("unknown_language", f"Unknown language {language}.")

        resolved = []
        for case in self._cases:
            reason = (case.get("skip") or {}).get(language)
            resolved.append({**case, "skipped": isinstance(reason, str), "skip_reason": reason})

        return resolved

    def skipped_ids(self, language: str) -> list[str]:
        return [case["id"] for case in self.cases(language) if case["skipped"]]


def _guard_cases(suite_id: str, cases: Any) -> None:
    if not isinstance(cases, list) or not cases:
        raise CorpusError("empty_suite", f"Suite {suite_id} has no cases.")

    seen: set[str] = set()
    previous: str | None = None

    for case in cases:
        case_id = case.get("id") if isinstance(case, dict) else None

        if not isinstance(case_id, str) or case_id == "":
            raise CorpusError("missing_case_id", f"A case in {suite_id} has no id.")

        if case_id in seen:
            raise CorpusError("duplicate_case_id", f"Case id {case_id} appears more than once in {suite_id}.")

        seen.add(case_id)

        # Ids are unique AND sorted. That is what makes "a new case goes at the
        # END of the file" a rule a machine enforces rather than a habit: file
        # order is not chronology, and inserting between two existing rows would
        # renumber ids that other repos' skip lists point at.
        if previous is not None and case_id <= previous:
            raise CorpusError(
                "unsorted_case_ids",
                f"Case id {case_id} follows {previous} in {suite_id}; ids must ascend. New cases go at the end.",
            )

        previous = case_id

        notes = case.get("notes")
        if not isinstance(notes, str) or not notes.strip():
            raise CorpusError(
                "missing_case_notes",
                f"Case {case_id} has no notes. A case without a stated purpose gets deleted by someone later.",
            )

        since = case.get("since")
        if not isinstance(since, str) or not since.strip():
            raise CorpusError(
                "missing_case_since",
                f"Case {case_id} does not say which corpus version it was added in.",
            )

        _guard_skip(case_id, case.get("skip"))


def _guard_skip(case_id: str, skip: Any) -> None:
    if skip is None:
        return

    # Pinned from BOTH directions. A loader that reads this as truthy skips the
    # row for every language at once AND makes the blank-reason guard below
    # unreachable, because a non-empty mapping is never blank.
    if not isinstance(skip, Mapping):
        raise CorpusError(
            "skip_must_be_a_map",
            f"Case {case_id} has a non-map skip. A skip is keyed by language; a scalar skips every language at once.",
        )

    for language, reason in skip.items():
        if language not in LANGUAGES:
            raise CorpusError("unknown_skip_language", f"Case {case_id} is skipped for unknown language {language}.")

        if not isinstance(reason, str) or not reason.strip():
            raise CorpusError(
                "blank_skip_reason",
                f"Case {case_id} skips {language} with no reason. "
                "A skip that does not say why becomes permanent silently.",
            )


def _walk(root: Path, relative: str) -> list[str]:
    full = root.joinpath(*relative.split("/"))

    if full.is_file():
        return [relative]

    if not full.is_dir():
        return []

    paths: list[str] = []
    for entry in full.iterdir():
        paths.extend(_walk(root, f"{relative}/{entry.name}"))

    return paths


class Corpus:
    def __init__(self, root: Path, version: str) -> None:
        self.root = root
        self.version = version
        self._suites: dict[str, Suite] = {}
        self._digest: str | None = None

    @classmethod
    def open(cls, root: Path | str | None = None) -> Corpus:
        """The root is discovered by default and still an EXPLICIT parameter.

        That is what lets the guards be exercised through this same code against
        a temporary root, rather than re-implemented inside a test -- which would
        assert nothing at all.
        """
        resolved = Path(root).resolve() if root is not None else discover_root()
        version_file = resolved / "VERSION"

        if not version_file.is_file():
            raise CorpusError(
                "corpus_not_installed",
                f"No VERSION file at {resolved}. The corpus ships inside this package; "
                "if it is missing, the package was assembled without running the sync step.",
            )

        return cls(resolved, version_file.read_text(encoding="utf-8").strip())

    def suite_ids(self) -> list[str]:
        base = self.root / "suites"

        return sorted(entry.name for entry in base.iterdir() if (entry / "cases.json").is_file())

    def suite(self, suite_id: str) -> Suite:
        if suite_id in self._suites:
            return self._suites[suite_id]

        directory = self.root / "suites" / suite_id

        for name in ("manifest.json", "cases.json"):
            if not (directory / name).is_file():
                raise CorpusError("corpus_not_installed", f"{name} is missing for suite {suite_id}.")

        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        document = json.loads((directory / "cases.json").read_text(encoding="utf-8"))

        if document.get("suite") != suite_id:
            raise CorpusError(
                "suite_id_mismatch",
                f"cases.json for {suite_id} declares suite {document.get('suite')!r}.",
            )

        _guard_cases(suite_id, document.get("cases"))

        suite = Suite(suite_id, manifest, document["cases"])
        self._suites[suite_id] = suite

        return suite

    def digest(self) -> str:
        """A content hash of every fixture this corpus ships.

        The VERSION number answers "which release is this?". It does not answer
        "are we all running the same bytes?", and those come apart: an installed
        copy mirrored before a suite was added reported one suite fewer and
        looked perfectly green, with the version unchanged because the CONTENT
        moved without the number moving. The digest is what cross-check.mjs
        compares so a stale artifact is a failure rather than a smaller pass.

        Files are read as RAW BYTES. Line endings are deliberately not
        normalised: if a checkout mangles them the digest SHOULD differ, because
        the files really are different.
        """
        if self._digest is not None:
            return self._digest

        paths: list[str] = []

        if (self.root / "VERSION").is_file():
            paths.append("VERSION")

        for directory in ("suites", "probes"):
            paths.extend(_walk(self.root, directory))

        # Vacuity guard. A discovery check that silently succeeds over an empty
        # set is worse than no check: it reports agreement it never looked for.
        if not paths:
            raise CorpusError(
                "corpus_not_installed",
                f"Found no fixture files under {self.root}, so there is nothing to digest.",
            )

        # Byte-wise ascending, with forward slashes on every platform. A digest
        # that differs by path separator between a Windows checkout and a Linux
        # CI runner is worse than no digest.
        paths.sort(key=lambda path: path.encode("utf-8"))

        hasher = hashlib.sha256()

        for path in paths:
            hasher.update(path.encode("utf-8"))
            hasher.update(b"\n")
            hasher.update(self.root.joinpath(*path.split("/")).read_bytes())
            hasher.update(b"\n")

        self._digest = f"sha256:{hasher.hexdigest()}"

        return self._digest

    def probes(self) -> dict[str, Any]:
        path = self.root / "probes" / "probes.json"

        if not path.is_file():
            raise CorpusError("corpus_not_installed", "probes/probes.json is missing from the corpus.")

        result: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        return result

    def expected_probe_failures(self, probe_id: str, language: str) -> dict[str, list[str]]:
        """The exact set of case ids a probe must fail in one language.

        The probe's declared set MINUS whatever that language skips: a skipped
        row cannot fail, so counting it would make the expectation unsatisfiable.
        """
        probes: Iterable[dict[str, Any]] = self.probes()["probes"]
        probe = next((candidate for candidate in probes if candidate["id"] == probe_id), None)

        if probe is None:
            raise CorpusError("unknown_probe", f"No probe named {probe_id}.")

        expected: dict[str, list[str]] = {}

        for suite_id, ids in (probe.get("must_fail") or {}).items():
            skipped = set(self.suite(suite_id).skipped_ids(language))
            expected[suite_id] = [case_id for case_id in ids if case_id not in skipped]

        return expected
