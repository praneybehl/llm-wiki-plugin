#!/usr/bin/env python3
"""Regression tests for mandatory init and upgrade runtime setup."""

import contextlib
import io
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


REPO = Path(__file__).resolve().parents[2]
SCRIPTS = REPO / "skills" / "llm-wiki" / "scripts"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sys.path.insert(0, str(SCRIPTS))

SETUP = load_module("setup_wiki", SCRIPTS / "setup_wiki.py")
INIT = load_module("init_wiki", SCRIPTS / "init_wiki.py")


class FakeConnection:
    def __init__(self):
        self.closed = False

    def execute(self, _sql):
        return FakeCursor()

    def close(self):
        self.closed = True


class FakeCursor:
    def fetchone(self):
        return (2,)


class RuntimeSetupTests(unittest.TestCase):
    def test_prepare_loads_all_dependencies_and_synchronizes_every_section(self):
        pages = [{"sections": ["a"]}, {"sections": ["b"]}]
        sections = [{"id": "a"}, {"id": "b"}]
        connection = FakeConnection()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            SETUP.wiki_search, "collect_pages", return_value=pages
        ), mock.patch.object(
            SETUP.wiki_search, "collect_sections", return_value=sections
        ), mock.patch.object(
            SETUP.wiki_search,
            "load_local_embedding_backend",
            return_value=("model", "sqlite_vec", 384),
        ), mock.patch.object(
            SETUP.wiki_search, "open_vector_index", return_value=connection
        ), mock.patch.object(
            SETUP.wiki_search,
            "sync_vector_index",
            return_value={"a": 1, "b": 2},
        ) as sync:
            result = SETUP.prepare(Path(tmp), Path(tmp) / "parse.json")

        sync.assert_called_once_with(connection, "sqlite_vec", "model", sections)
        self.assertTrue(connection.closed)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["sections"], 2)
        self.assertEqual(result["vectors"], 2)
        self.assertEqual(result["dimension"], 384)
        self.assertIn("pyyaml", result["dependencies"])

    def test_init_runtime_uses_pinned_setup_script(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            INIT.shutil, "which", return_value="/usr/local/bin/uv"
        ), mock.patch.object(INIT.subprocess, "run") as run, contextlib.redirect_stdout(io.StringIO()):
            INIT.install_runtime(Path(tmp) / "wiki")

        command = run.call_args.args[0]
        self.assertEqual(command[:3], ["/usr/local/bin/uv", "run", "--script"])
        self.assertEqual(Path(command[3]).name, "setup_wiki.py")
        self.assertEqual(command[-1], "--cache")
        self.assertTrue(run.call_args.kwargs["check"])

    def test_init_runtime_fails_closed_without_uv(self):
        with mock.patch.object(INIT.shutil, "which", return_value=None), self.assertRaises(
            SystemExit
        ), contextlib.redirect_stderr(io.StringIO()):
            INIT.install_runtime(Path("wiki"))


if __name__ == "__main__":
    unittest.main()
