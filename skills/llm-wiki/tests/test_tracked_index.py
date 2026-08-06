"""The vector index is only worth building if git will let you commit it.

Every assertion here goes through `git check-ignore` against a real repository
rather than reading a .gitignore, because that is the only honest check: the
rule can live in the wiki's own file, the repository root's, or a global
excludes file, and only git knows which one wins.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import init_wiki  # noqa: E402


def git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)


def init_repo(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    git(root, "init", "-q")


def is_ignored(root: Path, relative: str) -> bool:
    return git(root, "check-ignore", "-q", "--", relative).returncode == 0


def rules(path: Path) -> list[str]:
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")]


def scaffold(root: Path, upgrade: bool = False) -> str:
    """Run init_wiki() with the runtime install stubbed out."""
    output: list[str] = []
    with mock.patch.object(init_wiki, "install_runtime", lambda wiki: None), \
            mock.patch("builtins.print", lambda *a, **k: output.append(
                " ".join(str(part) for part in a))):
        init_wiki.init_wiki(root, "wiki", "raw", upgrade=upgrade)
    return "\n".join(output)


class TemplatePolicyTests(unittest.TestCase):
    def test_a_fresh_init_leaves_the_index_trackable(self):
        # The template shipped `*` + `!.gitignore`, which was right while
        # everything under .wiki-cache/ was disposable and wrong the moment the
        # vector index became a tracked artifact: a fresh init built the index
        # and then hid it, so `git add` refused it without -f.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            init_repo(root)

            scaffold(root)
            (root / "wiki" / ".wiki-cache" / "embeddings.sqlite").write_bytes(b"x")

            self.assertFalse(is_ignored(root, "wiki/.wiki-cache/embeddings.sqlite"))
            # The parse cache stays ignored: it rebuilds in seconds and churns.
            self.assertTrue(is_ignored(root, "wiki/.wiki-cache/search-index.json"))
            self.assertEqual(
                0, git(root, "add", "wiki/.wiki-cache/embeddings.sqlite").returncode)


class LegacyIgnoreMigrationTests(unittest.TestCase):
    """copy_template() cannot fix a file that already exists, so this can."""

    def legacy(self, root: Path) -> Path:
        cache_ignore = root / "wiki" / ".wiki-cache" / ".gitignore"
        cache_ignore.parent.mkdir(parents=True)
        cache_ignore.write_text("*\n!.gitignore\n", encoding="utf-8")
        return cache_ignore

    def test_upgrade_migrates_the_legacy_rule_set(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            init_repo(root)
            cache_ignore = self.legacy(root)

            scaffold(root, upgrade=True)

            self.assertEqual(["*", "!.gitignore", "!embeddings.sqlite"],
                             rules(cache_ignore))
            self.assertFalse(is_ignored(root, "wiki/.wiki-cache/embeddings.sqlite"))

    def test_migration_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            init_repo(root)
            cache_ignore = self.legacy(root)

            scaffold(root, upgrade=True)
            once = cache_ignore.read_text(encoding="utf-8")
            scaffold(root, upgrade=True)

            self.assertEqual(once, cache_ignore.read_text(encoding="utf-8"))

    def test_a_customized_ignore_file_is_reported_not_rewritten(self):
        # An idempotent upgrade must not edit a file the user has touched, so
        # the blocker is reported with the exact line to add instead.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            init_repo(root)
            cache_ignore = root / "wiki" / ".wiki-cache" / ".gitignore"
            cache_ignore.parent.mkdir(parents=True)
            original = "*\n!.gitignore\n!my-own-artifact.bin\n"
            cache_ignore.write_text(original, encoding="utf-8")

            with self.assertRaises(SystemExit):
                scaffold(root, upgrade=True)

            self.assertEqual(original, cache_ignore.read_text(encoding="utf-8"))
            self.assertEqual("custom", init_wiki.migrate_wiki_cache_gitignore(cache_ignore))

    def test_an_absent_file_is_left_to_the_template(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "wiki" / ".wiki-cache" / ".gitignore"

            self.assertEqual("absent", init_wiki.migrate_wiki_cache_gitignore(missing))


class IgnoreRuleDetectionTests(unittest.TestCase):
    def test_a_deeper_negation_beats_a_root_pattern(self):
        # A root `*.sqlite` is not a blocker: rules in a deeper directory win,
        # so the template's own negation rescues the index without help. This is
        # also why `check-ignore -v` cannot carry the verdict -- it exits 0 for a
        # path matching a *negated* pattern too, and would report
        # `!embeddings.sqlite` as the rule hiding the index.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            init_repo(root)
            (root / ".gitignore").write_text("*.sqlite\n", encoding="utf-8")

            output = scaffold(root)

            self.assertNotIn("git-ignored", output)
            self.assertFalse(is_ignored(root, "wiki/.wiki-cache/embeddings.sqlite"))

    def test_an_excluded_parent_directory_is_detected_and_named(self):
        # The one shape the negation cannot fix: git never descends into an
        # excluded directory, so `!embeddings.sqlite` inside it is dead text.
        # The rule also lives outside the wiki, which is why the check asks git
        # instead of reading .wiki-cache/.gitignore.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            init_repo(root)
            (root / ".gitignore").write_text(".wiki-cache/\n", encoding="utf-8")

            rule = init_wiki.index_ignore_rule(
                root, root / "wiki" / ".wiki-cache" / "embeddings.sqlite")

            self.assertIsNotNone(rule)
            self.assertIn(".wiki-cache/", rule)

    def test_a_directory_outside_git_is_not_treated_as_blocked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            root.mkdir(parents=True)

            self.assertIsNone(init_wiki.index_ignore_rule(
                root, root / "wiki" / ".wiki-cache" / "embeddings.sqlite"))

            output = scaffold(root)
            self.assertNotIn("git-ignored", output)


class BlockedIndexCliTests(unittest.TestCase):
    def test_a_blocked_index_fails_before_the_runtime_install(self):
        # Delivering this news after a full embed pass would waste the pass, so
        # the check runs first and is fatal.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            init_repo(root)
            (root / ".gitignore").write_text(".wiki-cache/\n", encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "init_wiki.py"), ".", "--upgrade"],
                cwd=root, capture_output=True, text=True, encoding="utf-8",
            )

            self.assertEqual(1, result.returncode)
            self.assertIn("Blocked", result.stderr)
            self.assertIn("excluded", result.stderr)
            self.assertNotIn("Installing", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
