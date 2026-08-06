"""`--json` is a consumer contract, so it holds on the failure paths too.

Every test here drives the real CLI in a subprocess. That is the point: the
failures being pinned down are argparse's own error path, an early `return`,
and a bare `sys.exit`, none of which are visible from an in-process call.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def build_wiki(root: Path, names: tuple[str, ...] = ("alpha",)) -> None:
    (root / "concepts").mkdir(parents=True)
    for name in names:
        (root / "concepts" / f"{name}.md").write_text(
            f"---\ntype: concept\ntitle: {name}\n---\n\n# {name}\n\nGamma delta.\n",
            encoding="utf-8",
        )


def run_search(root: Path, *extra: str, json_mode: bool = True) -> subprocess.CompletedProcess:
    command = [sys.executable, str(SCRIPTS / "wiki_search.py"), *extra,
               "--wiki", str(root), "--no-embed"]
    if json_mode:
        command.append("--json")
    return subprocess.run(command, capture_output=True, text=True, encoding="utf-8")


class JsonEnvelopeTests(unittest.TestCase):
    def test_untokenizable_query_still_returns_json_and_fails(self):
        # The tokenizer keeps [a-z0-9]+, so a query in a non-Latin script has
        # nothing to match. That used to print "Empty query." to stderr and
        # return, leaving stdout empty with exit code 0 -- indistinguishable
        # from a crash to anything parsing the output.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)

            result = run_search(root, "вирівнювання")
            payload = json.loads(result.stdout)

            self.assertEqual(2, result.returncode)
            self.assertEqual([], payload["results"])
            self.assertIn("no searchable tokens", payload["error"])

    def test_missing_query_returns_json_instead_of_help(self):
        # An empty query printed argparse help to stdout, which is neither JSON
        # nor an error code.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)

            result = run_search(root, "")
            payload = json.loads(result.stdout)

            self.assertEqual(2, result.returncode)
            self.assertIsNotNone(payload["error"])

    def test_a_missing_wiki_is_reported_in_the_envelope(self):
        with tempfile.TemporaryDirectory() as directory:
            result = run_search(Path(directory) / "absent", "gamma")
            payload = json.loads(result.stdout)

            self.assertEqual(1, result.returncode)
            self.assertIn("not found", payload["error"])

    def test_an_empty_wiki_is_reported_in_the_envelope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            root.mkdir()

            result = run_search(root, "gamma")
            payload = json.loads(result.stdout)

            self.assertEqual(0, result.returncode)
            self.assertEqual([], payload["results"])
            self.assertIn("No wiki pages", payload["error"])

    def test_successful_query_reports_no_error(self):
        # `error` is present and null on success, so a consumer branches on one
        # field rather than on whether stdout happened to be empty.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)

            result = run_search(root, "gamma")
            payload = json.loads(result.stdout)

            self.assertEqual(0, result.returncode)
            self.assertIn("error", payload)
            self.assertIsNone(payload["error"])
            self.assertEqual("alpha", payload["results"][0]["slug"])


class CountArgumentTests(unittest.TestCase):
    """Count flags are rejected up front instead of failing three different ways."""

    def test_non_positive_counts_fail_with_a_parseable_envelope(self):
        # Raw `type=int` let each of these through, and each failed silently and
        # differently: --top 0 returned one section but no pages, a negative
        # --top-linked became a negative list slice, and --per-page 0 dropped
        # every result while still exiting 0.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root, ("alpha", "beta"))

            for flag, value in (("--top", "0"), ("--top", "-1"),
                                ("--top-linked", "-1"), ("--per-page", "0")):
                with self.subTest(flag=flag, value=value):
                    result = run_search(root, "gamma", flag, value)
                    payload = json.loads(result.stdout)

                    self.assertEqual(2, result.returncode)
                    self.assertEqual([], payload["results"])
                    self.assertIn(flag, payload["error"])
                    self.assertIn("positive", payload["error"])

    def test_without_json_the_same_rejection_goes_to_stderr(self):
        # Validating in `type=` would route this through argparse's usage text,
        # which no structured consumer can read -- hence the check after
        # parse_args() and the shared fail() helper.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root, ("alpha", "beta"))

            result = run_search(root, "gamma", "--per-page", "0", json_mode=False)

            self.assertEqual(2, result.returncode)
            self.assertIn("--per-page", result.stderr)
            self.assertEqual("", result.stdout)

    def test_positive_counts_still_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root, ("alpha", "beta"))

            result = run_search(root, "gamma", "--top", "1")

            self.assertEqual(0, result.returncode)
            self.assertEqual(1, len(json.loads(result.stdout)["results"]))


if __name__ == "__main__":
    unittest.main()
