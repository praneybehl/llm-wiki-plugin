#!/usr/bin/env python3
"""
Tests for skills/llm-wiki/scripts/wiki_remote.py.

The tests start an in-process fake server (stdlib http.server in a thread).
The fake server copies the parts of the v4 JSON API that the CLI uses.
No network access and no real wiki data are necessary.

Run:
    python eval/remote/test_remote.py
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "skills" / "llm-wiki" / "scripts" / "wiki_remote.py"
sys.path.insert(0, str(SCRIPT.parent))

import wiki_remote  # noqa: E402

TOKEN = "lw_main_" + "S" * 43
ADMIN = "admin-secret-token"


def sha(text: str | bytes) -> str:
    data = text.encode("utf-8") if isinstance(text, str) else text
    return hashlib.sha256(data).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class FakeWiki:
    """In-memory state of one hosted wiki."""

    def __init__(self):
        self.lock = threading.Lock()
        self.pages: dict[str, dict] = {}
        self.deleted: dict[str, int] = {}
        self.last_change: dict[str, int] = {}
        self.seq = 0
        self.raw: dict[str, dict] = {}
        self.raw_enabled = True
        self.requests: list[tuple[str, str, dict, dict]] = []
        self.fail_next: dict[tuple[str, str], list[int]] = {}
        self.fail_commit_from: int | None = None
        self.commit_calls = 0
        self.commits: list[dict] = []
        self.corrupt: set[str] = set()
        self.truncate_export = False
        # Called with the wiki before each commit is checked (simulates a concurrent agent).
        self.before_commit = None
        # Apply the next N commits, then answer 503 as if the response was lost.
        self.lose_responses = 0

    # -- helpers used by tests ------------------------------------------------
    def seed(self, path: str, content: str, author: str = "agent") -> None:
        with self.lock:
            self._write(path, content, author)

    def remove(self, path: str) -> None:
        with self.lock:
            self.seq += 1
            self.pages.pop(path)
            self.deleted[path] = self.seq
            self.last_change[path] = self.seq

    def count(self, method: str, path: str) -> int:
        return sum(1 for m, p, _, _ in self.requests if m == method and p == path)

    # -- internals -------------------------------------------------------------
    def _write(self, path: str, content: str, author: str) -> dict:
        self.seq += 1
        stored = content + "\n<!-- corrupted -->" if path in self.corrupt else content
        rec = {
            "path": path,
            "rev": self.seq,
            "sha256": sha(stored),
            "bytes": len(stored.encode("utf-8")),
            "content": stored,
            "updated_at": now(),
            "updated_by": author,
        }
        self.pages[path] = rec
        self.deleted.pop(path, None)
        self.last_change[path] = self.seq
        return rec

    def commit(self, body: dict, author: str):
        hook, self.before_commit = self.before_commit, None
        if hook:
            hook(self)
        with self.lock:
            self.commit_calls += 1
            if self.fail_commit_from is not None and self.commit_calls >= self.fail_commit_from:
                return 500, {"error": {"code": "internal", "message": "simulated failure"}}
            ops = body.get("ops") or []
            for i, op in enumerate(ops):
                path = op.get("path")
                cur = self.pages.get(path)
                kind = op["op"]
                if kind == "create" and cur:
                    return 409, self._conflict(i, path, "exists", cur)
                if kind == "upsert" and "expected_sha256" in op:
                    expected = op["expected_sha256"]
                    if expected is None and cur:
                        return 409, self._conflict(i, path, "exists", cur)
                    if expected is not None and (not cur or cur["sha256"] != expected):
                        return 409, self._conflict(i, path, "sha_mismatch", cur)
                if kind in ("put", "delete"):
                    if not cur:
                        return 409, self._conflict(i, path, "missing", None)
                    if op.get("base_rev") != cur["rev"]:
                        return 409, self._conflict(i, path, "stale_base_rev", cur, op.get("base_rev"))
            changed = []
            seq_before = self.seq
            for op in ops:
                kind = op["op"]
                if kind == "delete":
                    self.seq += 1
                    self.pages.pop(op["path"])
                    self.deleted[op["path"]] = self.seq
                    self.last_change[op["path"]] = self.seq
                    changed.append({"path": op["path"], "rev": self.seq, "sha256": "", "deleted": True})
                else:
                    rec = self._write(op["path"], op["content"], author)
                    changed.append({"path": rec["path"], "rev": rec["rev"], "sha256": rec["sha256"]})
            self.commits.append(body)
            if self.lose_responses:
                self.lose_responses -= 1
                return 503, {"error": {"code": "unavailable", "message": "response lost"}}
            return 200, {
                "commit_id": f"c{len(self.commits)}",
                "seq": self.seq if changed else seq_before,
                "changed": changed,
                "review_flags": 0,
            }

    @staticmethod
    def _conflict(i, path, reason, cur, base=None):
        details = {"op_index": i, "path": path, "reason": reason, "current_rev": cur["rev"] if cur else None}
        if cur:
            details["current_sha256"] = cur["sha256"]
        if base is not None:
            details["base_rev"] = base
        return {"error": {"code": "conflict", "message": f"{reason} at {path}", "details": details}}

    def move(self, src: str, dst: str) -> None:
        """One commit that moves a page: both changes share one seq, like the real server."""
        with self.lock:
            self.seq += 1
            rec = dict(self.pages.pop(src), path=dst, rev=self.seq)
            self.pages[dst] = rec
            self.deleted[src] = self.seq
            self.last_change[src] = self.seq
            self.last_change[dst] = self.seq

    def changes(self, since: int, limit: int) -> dict:
        with self.lock:
            items = sorted((s, p) for p, s in self.last_change.items() if s > since)
            more = len(items) > limit
            items = items[:limit]
            out = []
            for s, p in items:
                if p in self.pages:
                    r = self.pages[p]
                    out.append({"path": p, "rev": r["rev"], "sha256": r["sha256"], "deleted": False, "content": r["content"]})
                else:
                    out.append({"path": p, "rev": s, "sha256": "", "deleted": True})
            next_since = items[-1][0] if (more and items) else self.seq
            return {"seq": self.seq, "changes": out, "more": more, "next_since": next_since}


class Handler(BaseHTTPRequestHandler):
    wiki: FakeWiki

    def log_message(self, fmt, *args):  # noqa: D401 - keep test output clean
        pass

    def _send(self, status: int, payload=None, body: bytes | None = None, ctype="application/json"):
        if body is None:
            body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status, code, message):
        self._send(status, {"error": {"code": code, "message": message}})

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _handle(self):
        w = self.wiki
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query, keep_blank_values=True).items()}
        w.requests.append((self.command, route, query, dict(self.headers)))
        body = self._body() if self.command in ("POST", "PUT", "PATCH") else b""

        queue = w.fail_next.get((self.command, route))
        if queue:
            status = queue.pop(0)
            return self._error(status, "unavailable", "simulated outage")

        auth = self.headers.get("Authorization", "")
        if auth not in (f"Bearer {TOKEN}", f"Bearer {ADMIN}"):
            return self._error(401, "unauthorized", "bad token")
        admin = auth == f"Bearer {ADMIN}"
        author = "admin" if admin else "importer"

        if route == "/api/v1/whoami":
            return self._send(200, {"wiki": "main", "label": author, "scopes": ["read", "write", "raw:write"], "admin": admin})
        if route == "/api/v1/overview":
            return self._send(200, {"wiki": "main", "server_version": "4.0.0", "seq": w.seq, "pages": len(w.pages),
                                    "sections": 0, "bytes": 0, "vector_lag": 0, "vectors_enabled": False,
                                    "raw_enabled": w.raw_enabled, "decisions": {"enabled": False, "backend": "workers-ai",
                                    "model": "typesafe/jev-1.14.0"}, "schema": None, "index": None, "open_review_flags": 0})
        if route == "/api/v1/manifest":
            with w.lock:
                return self._send(200, {"seq": w.seq, "pages": {p: r["sha256"] for p, r in w.pages.items()}})
        if route == "/api/v1/changes":
            return self._send(200, w.changes(int(query.get("since", 0)), min(int(query.get("limit", 50)), 200)))
        if route == "/api/v1/page":
            rec = w.pages.get(query.get("path", ""))
            return self._send(200, rec) if rec else self._error(404, "not_found", "no page")
        if route == "/api/v1/read":
            req = json.loads(body)
            pages = [w.pages[p] for p in req["paths"] if p in w.pages]
            return self._send(200, {"pages": pages, "missing": [p for p in req["paths"] if p not in w.pages]})
        if route == "/api/v1/search":
            req = json.loads(body)
            rows = [
                {"slug": p.rsplit("/", 1)[-1][:-3], "rel_path": p, "type": None, "title": p, "heading_path": [],
                 "section_index": 0, "score": 1.0, "retrievers": ["bm25"], "snippet": r["content"][:40],
                 "updated": None, "tags": [], "sources": [], "neighbors": {"prev": None, "next": None}}
                for p, r in sorted(w.pages.items()) if req["query"].lower() in r["content"].lower()
            ]
            return self._send(200, {"query": req["query"], "wiki": "main", "granularity": "section",
                                    "mode": req.get("mode", "hybrid"), "results": rows, "vector_lag": 0})
        if route == "/api/v1/commit":
            status, payload = w.commit(json.loads(body), author)
            return self._send(status, payload)
        if route == "/api/v1/history":
            return self._send(200, [{"commit_id": f"c{i + 1}", "seq": i + 1, "author": "a", "message": c["message"],
                                     "created_at": now(), "paths": [o.get("path") for o in c["ops"]]}
                                    for i, c in enumerate(w.commits)])
        if route == "/api/v1/export":
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            for rec in sorted(w.pages.values(), key=lambda r: r["path"]):
                self.wfile.write((json.dumps(rec) + "\n").encode("utf-8"))
            if not w.truncate_export:
                self.wfile.write((json.dumps({"done": True, "seq": w.seq}) + "\n").encode("utf-8"))
            return None
        if route == "/api/v1/raw":
            if not w.raw_enabled:
                return self._error(503, "unavailable", "no raw storage")
            prefix = query.get("prefix", "")
            return self._send(200, [r["entry"] for p, r in sorted(w.raw.items()) if p.startswith(prefix)])
        if route.startswith("/api/v1/raw/"):
            if not w.raw_enabled:
                return self._error(503, "unavailable", "no raw storage")
            rel = urllib.parse.unquote(route[len("/api/v1/raw/"):])
            if self.command == "PUT":
                given = self.headers.get("X-Content-SHA256")
                if not given or given != sha(body):
                    return self._error(400, "bad_request", "sha mismatch")
                cur = w.raw.get(rel)
                if cur:
                    if cur["entry"]["sha256"] == given:
                        return self._send(200, cur["entry"])
                    return self._error(409, "conflict", "raw files are immutable")
                entry = {"path": rel, "bytes": len(body), "sha256": given,
                         "content_type": self.headers.get("Content-Type"), "uploaded_at": now(), "uploaded_by": author}
                w.raw[rel] = {"data": body, "entry": entry}
                return self._send(201, entry)
            cur = w.raw.get(rel)
            if not cur:
                return self._error(404, "not_found", "no raw file")
            return self._send(200, body=cur["data"], ctype=cur["entry"]["content_type"] or "application/octet-stream")
        return self._error(404, "not_found", f"no route {route}")

    def do_GET(self):
        self._handle()

    def do_HEAD(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def do_PUT(self):
        self._handle()

    def do_PATCH(self):
        self._handle()

    def do_DELETE(self):
        self._handle()


def run_cli(*argv: str, stdin: str | None = None) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    old_stdin = sys.stdin
    if stdin is not None:
        sys.stdin = io.StringIO(stdin)
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = wiki_remote.main(list(argv))
            except SystemExit as exc:
                code = exc.code if isinstance(exc.code, int) else 1
    finally:
        sys.stdin = old_stdin
    return code, out.getvalue(), err.getvalue()


def tree_snapshot(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): sha(p.read_bytes()) if p.is_file() else "dir"
        for p in sorted(root.rglob("*"))
    }


class RemoteTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="llm-wiki-remote-test-"))
        self.wiki = FakeWiki()
        handler = type("BoundHandler", (Handler,), {"wiki": self.wiki})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self._env = {k: os.environ.get(k) for k in ("LLM_WIKI_CONFIG", "LLM_WIKI_URL", "LLM_WIKI_TOKEN")}
        os.environ["LLM_WIKI_CONFIG"] = str(self.tmp / "config" / "remote.json")
        os.environ["LLM_WIKI_URL"] = self.url
        os.environ["LLM_WIKI_TOKEN"] = TOKEN
        self._delays = wiki_remote.RETRY_DELAYS
        wiki_remote.RETRY_DELAYS = (0.0, 0.0, 0.0, 0.0)

    def tearDown(self):
        wiki_remote.RETRY_DELAYS = self._delays
        self.server.shutdown()
        self.server.server_close()
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def make_wiki(self) -> Path:
        root = self.tmp / "wiki"
        files = {
            "SCHEMA.md": "# Schema\n",
            "index.md": "# Index\n- [[alpha]]\n",
            "log.md": "# Log\n",
            "entities/alpha.md": "---\ntype: entity\n---\n# Alpha\nAlpha text.\n",
            "entities/beta.md": "---\ntype: entity\n---\n# Beta\nBeta text.\r\nCRLF line.\n",
            "concepts/gamma.md": "# Gamma\nUnicode: caf\u00e9 \u00fc\n",
            "indexes/entities.md": "# Entities\n",
            "graph/ontology.yaml": "predicates: {}\n",
            ".pattern-template.md": "# Template\n",
        }
        for rel, text in files.items():
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(text.encode("utf-8"))
        (root / "graph" / "graph.jsonl").write_text('{"x": 1}\n', encoding="utf-8")
        (root / ".obsidian").mkdir()
        (root / ".obsidian" / "app.json").write_text("{}", encoding="utf-8")
        (root / ".git").mkdir()
        (root / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
        (root / ".wiki-cache").mkdir()
        (root / ".wiki-cache" / "cache.md").write_text("cache\n", encoding="utf-8")
        (root / ".DS_Store").write_bytes(b"\x00\x01")
        (root / "assets").mkdir()
        (root / "assets" / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n\xff\xfe\x00")
        (root / "big.md").write_bytes(b"a" * (wiki_remote.MAX_PAGE_BYTES + 1))
        (root / "raw").mkdir()
        (root / "raw" / "paper.pdf").write_bytes(b"%PDF-1.4 \x00\xff binary")
        (root / "raw" / "notes").mkdir()
        (root / "raw" / "notes" / "call.txt").write_text("call notes\n", encoding="utf-8")
        return root

    def import_report(self, *args: str, expect: int = 0) -> dict:
        code, out, err = run_cli("import", *args)
        self.assertEqual(code, expect, msg=f"stdout={out}\nstderr={err}")
        return json.loads(out)

    EXPECTED_PAGES = {
        "SCHEMA.md", "index.md", "log.md", "entities/alpha.md", "entities/beta.md", "concepts/gamma.md",
        "indexes/entities.md", "graph/ontology.yaml", ".pattern-template.md",
    }


class LoginAndConfigTests(RemoteTestCase):
    def test_login_saves_profile_with_mode_0600(self):
        os.environ.pop("LLM_WIKI_URL")
        os.environ.pop("LLM_WIKI_TOKEN")
        code, out, err = run_cli("login", "--url", self.url + "/", "--token", TOKEN, "--profile", "work")
        self.assertEqual(code, 0, err)
        cfg_path = Path(os.environ["LLM_WIKI_CONFIG"])
        mode = stat.S_IMODE(cfg_path.stat().st_mode)
        self.assertEqual(mode, 0o600)
        cfg = json.loads(cfg_path.read_text())
        self.assertEqual(cfg["default"], "work")
        self.assertEqual(cfg["profiles"]["work"], {"url": self.url, "token": TOKEN})
        self.assertNotIn(TOKEN, out)
        code, out, _ = run_cli("--json", "status")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["whoami"]["wiki"], "main")
        self.assertNotIn(TOKEN, out)

    def test_login_reads_token_from_stdin(self):
        code, _, err = run_cli("login", "--url", self.url, "--token", "-", stdin=TOKEN + "\n")
        self.assertEqual(code, 0, err)

    def test_login_rejects_bad_token_and_keeps_config(self):
        code, _, err = run_cli("login", "--url", self.url, "--token", "lw_main_wrong")
        self.assertEqual(code, 1)
        self.assertIn("401", err)
        self.assertFalse(Path(os.environ["LLM_WIKI_CONFIG"]).exists())

    def test_login_accepts_the_global_url_option(self):
        os.environ.pop("LLM_WIKI_URL")
        code, _, err = run_cli("--url", self.url, "login", "--token", TOKEN)
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(Path(os.environ["LLM_WIKI_CONFIG"]).read_text())["profiles"]["default"]["url"], self.url)

    def test_missing_url_is_usage_error(self):
        os.environ.pop("LLM_WIKI_URL")
        code, _, err = run_cli("status")
        self.assertEqual(code, 2)
        self.assertIn("login", err)

    def test_unknown_profile_is_usage_error(self):
        code, _, _ = run_cli("--profile", "nope", "status")
        self.assertEqual(code, 2)

    def test_lax_config_mode_warns(self):
        run_cli("login", "--url", self.url, "--token", TOKEN)
        cfg_path = Path(os.environ["LLM_WIKI_CONFIG"])
        os.chmod(cfg_path, 0o644)
        code, _, err = run_cli("status")
        self.assertEqual(code, 0)
        self.assertIn("chmod 600", err)


class ClientQueryTests(unittest.TestCase):
    def test_get_accepts_a_query_parameter_named_path(self):
        # history, diff and revision send `path` as a query parameter; it must not
        # collide with the route argument of Client.get.
        client = wiki_remote.Client("http://127.0.0.1:1", TOKEN)
        seen: dict = {}

        def fake_call(method, route, query=None, body=None, idempotent=None):
            seen.update(method=method, route=route, query=query)
            return {}

        client.call = fake_call
        client.get("/api/v1/history", path="concepts/a.md", limit=5)
        self.assertEqual(seen, {"method": "GET", "route": "/api/v1/history", "query": {"path": "concepts/a.md", "limit": 5}})


class ImportTests(RemoteTestCase):
    def test_dry_run_plans_without_writes(self):
        root = self.make_wiki()
        before = tree_snapshot(root)
        report = self.import_report(str(root), "--dry-run", "--batch-files", "4")
        self.assertEqual(self.wiki.commit_calls, 0)
        self.assertEqual(self.wiki.count("PUT", "/api/v1/raw/paper.pdf"), 0)
        planned = {p for b in report["plan"]["batches"] for p in b}
        self.assertEqual(planned, self.EXPECTED_PAGES)
        self.assertEqual(len(report["plan"]["batches"]), 3)
        self.assertEqual(sorted(report["plan"]["raw_uploads"]), ["notes/call.txt", "paper.pdf"])
        self.assertEqual(tree_snapshot(root), before)

    def test_import_batches_skips_and_reports(self):
        root = self.make_wiki()
        before = tree_snapshot(root)
        report = self.import_report(str(root), "--batch-files", "2")
        self.assertEqual(set(self.wiki.pages), self.EXPECTED_PAGES)
        self.assertEqual(len(self.wiki.commits), 5)
        for body in self.wiki.commits:
            self.assertLessEqual(len(body["ops"]), 2)
            self.assertTrue(all(op["op"] == "upsert" for op in body["ops"]))
            self.assertRegex(body["message"], r"^import: \d+ pages from wiki$")
        reasons = {s["path"]: s["reason"] for s in report["skipped"]}
        self.assertEqual(reasons["big.md"], "too_large")
        self.assertEqual(reasons["assets/logo.png"], "not_utf8")
        self.assertEqual(reasons["graph/graph.jsonl"], "generated")
        self.assertNotIn(".obsidian/app.json", reasons)
        for page in self.EXPECTED_PAGES:
            self.assertEqual(self.wiki.pages[page]["sha256"], sha((root / page).read_bytes()))
        self.assertEqual(set(self.wiki.raw), {"paper.pdf", "notes/call.txt"})
        self.assertTrue(report["ok"])
        self.assertEqual(report["verification"]["mismatches"], [])
        self.assertEqual(report["verification"]["raw_checked"], 2)
        self.assertEqual(tree_snapshot(root), before)

    def test_batch_bytes_limit(self):
        root = self.make_wiki()
        self.import_report(str(root), "--batch-bytes", "30", "--no-raw")
        self.assertGreater(len(self.wiki.commits), 3)
        sizes = [sum(len(op["content"].encode()) for op in b["ops"]) for b in self.wiki.commits]
        for body, size in zip(self.wiki.commits, sizes):
            self.assertTrue(len(body["ops"]) == 1 or size <= 30)
        self.assertEqual(self.wiki.raw, {})

    def test_second_import_skips_identical(self):
        root = self.make_wiki()
        self.import_report(str(root))
        commits, puts = len(self.wiki.commits), self.wiki.count("PUT", "/api/v1/raw/paper.pdf")
        report = self.import_report(str(root))
        self.assertEqual(len(self.wiki.commits), commits)
        self.assertEqual(self.wiki.count("PUT", "/api/v1/raw/paper.pdf"), puts)
        self.assertEqual(report["pages"]["identical"], len(self.EXPECTED_PAGES))
        self.assertEqual(report["raw"]["identical"], 2)

    def test_reimport_replaces_pages_written_by_earlier_import(self):
        root = self.make_wiki()
        self.import_report(str(root), "--no-raw")
        (root / "entities" / "alpha.md").write_text("# Alpha v2\n", encoding="utf-8")
        report = self.import_report(str(root), "--no-raw")
        self.assertEqual(report["pages"]["uploaded"], 1)
        self.assertEqual(self.wiki.pages["entities/alpha.md"]["content"], "# Alpha v2\n")

    def test_refuses_divergent_remote_without_overwrite(self):
        root = self.make_wiki()
        self.wiki.seed("entities/alpha.md", "# Alpha written by an agent\n")
        report = self.import_report(str(root), "--no-raw", expect=3)
        self.assertEqual(self.wiki.commit_calls, 0)
        self.assertEqual([d["path"] for d in report["pages"]["divergent"]], ["entities/alpha.md"])
        report = self.import_report(str(root), "--no-raw", "--overwrite")
        self.assertTrue(report["ok"])
        self.assertEqual(self.wiki.pages["entities/alpha.md"]["sha256"], sha((root / "entities/alpha.md").read_bytes()))

    def test_resume_after_failure_mid_import(self):
        root = self.make_wiki()
        self.wiki.fail_commit_from = 2
        report = self.import_report(str(root), "--batch-files", "3", "--no-raw", expect=1)
        self.assertEqual(report["interrupted"]["batch"], 2)
        self.assertEqual(len(self.wiki.commits), 1)
        done_first = {op["path"] for op in self.wiki.commits[0]["ops"]}
        self.wiki.fail_commit_from = None
        report = self.import_report(str(root), "--batch-files", "3", "--no-raw")
        self.assertTrue(report["ok"])
        self.assertEqual(report["pages"]["identical"], 3)
        resent = {op["path"] for b in self.wiki.commits[1:] for op in b["ops"]}
        self.assertFalse(resent & done_first)
        self.assertEqual(set(self.wiki.pages), self.EXPECTED_PAGES)

    def test_verification_mismatch_exits_1(self):
        root = self.make_wiki()
        self.wiki.corrupt.add("concepts/gamma.md")
        report = self.import_report(str(root), "--no-raw", expect=1)
        self.assertFalse(report["ok"])
        self.assertEqual([m["path"] for m in report["verification"]["mismatches"]], ["concepts/gamma.md"])

    def test_raw_upload_sends_sha_and_skips_present(self):
        root = self.make_wiki()
        self.wiki.raw["paper.pdf"] = {
            "data": (root / "raw/paper.pdf").read_bytes(),
            "entry": {"path": "paper.pdf", "bytes": 1, "sha256": sha((root / "raw/paper.pdf").read_bytes()),
                      "content_type": "application/pdf", "uploaded_at": now(), "uploaded_by": "x"},
        }
        report = self.import_report(str(root))
        self.assertEqual(report["raw"]["uploaded"], 1)
        self.assertEqual(self.wiki.count("PUT", "/api/v1/raw/paper.pdf"), 0)
        puts = [r for r in self.wiki.requests if r[0] == "PUT"]
        self.assertEqual(len(puts), 1)
        headers = {k.lower(): v for k, v in puts[0][3].items()}
        self.assertEqual(headers["x-content-sha256"], sha(b"call notes\n"))
        self.assertEqual(headers["user-agent"], "llm-wiki-remote/4.0.0")

    def test_raw_unavailable_fails_verification(self):
        root = self.make_wiki()
        self.wiki.raw_enabled = False
        report = self.import_report(str(root), expect=1)
        self.assertIn("--no-raw", report["raw"]["error"])
        self.assertEqual(set(self.wiki.pages), self.EXPECTED_PAGES)

    def test_upserts_carry_the_remote_sha_they_expect(self):
        root = self.make_wiki()
        self.import_report(str(root), "--no-raw")
        ops = [op for body in self.wiki.commits for op in body["ops"]]
        self.assertTrue(ops)
        self.assertTrue(all("expected_sha256" in op and op["expected_sha256"] is None for op in ops))
        (root / "entities" / "alpha.md").write_text("# Alpha v2\n", encoding="utf-8")
        old = self.wiki.pages["entities/alpha.md"]["sha256"]
        self.import_report(str(root), "--no-raw")
        self.assertEqual(self.wiki.commits[-1]["ops"][0]["expected_sha256"], old)

    def test_remote_edit_after_manifest_read_is_not_overwritten(self):
        root = self.make_wiki()
        self.import_report(str(root), "--no-raw")
        (root / "entities" / "alpha.md").write_text("# Alpha v2\n", encoding="utf-8")
        (root / "entities" / "beta.md").write_text("# Beta v2\n", encoding="utf-8")
        agent = "# Alpha edited by an agent during the import\n"
        # The agent writes after the import read the manifest and before its commit.
        self.wiki.before_commit = lambda w: w.seed("entities/alpha.md", agent)
        report = self.import_report(str(root), "--no-raw", expect=3)
        self.assertEqual(self.wiki.pages["entities/alpha.md"]["content"], agent)
        self.assertEqual(self.wiki.pages["entities/beta.md"]["content"], "# Beta v2\n")
        self.assertEqual([c["path"] for c in report["pages"]["changed_during_import"]], ["entities/alpha.md"])
        self.assertFalse(report["ok"])

    def test_new_remote_page_after_manifest_read_is_not_overwritten(self):
        root = self.make_wiki()
        agent = "# Gamma made by an agent\n"
        self.wiki.before_commit = lambda w: w.seed("concepts/gamma.md", agent)
        report = self.import_report(str(root), "--no-raw", expect=3)
        self.assertEqual(self.wiki.pages["concepts/gamma.md"]["content"], agent)
        self.assertEqual([c["path"] for c in report["pages"]["changed_during_import"]], ["concepts/gamma.md"])
        self.assertEqual(set(self.wiki.pages), self.EXPECTED_PAGES)

    def test_retry_after_lost_response_counts_pages_as_done(self):
        root = self.make_wiki()
        self.wiki.lose_responses = 1
        report = self.import_report(str(root), "--no-raw")
        self.assertTrue(report["ok"])
        self.assertEqual(report["pages"]["uploaded"], len(self.EXPECTED_PAGES))
        self.assertEqual(len(self.wiki.commits), 1)
        for page in self.EXPECTED_PAGES:
            self.assertEqual(self.wiki.pages[page]["sha256"], sha((root / page).read_bytes()))

    def test_retry_after_lost_response_does_not_replay_over_an_agent_edit(self):
        root = self.make_wiki()
        agent = "# Alpha edited by an agent between the two requests\n"

        def first(w):
            w.before_commit = lambda w2: w2.seed("entities/alpha.md", agent)

        self.wiki.before_commit = first
        self.wiki.lose_responses = 1
        report = self.import_report(str(root), "--no-raw", expect=3)
        self.assertEqual(self.wiki.pages["entities/alpha.md"]["content"], agent)
        self.assertEqual([c["path"] for c in report["pages"]["changed_during_import"]], ["entities/alpha.md"])
        self.assertEqual(report["pages"]["uploaded"], len(self.EXPECTED_PAGES) - 1)

    def test_batches_reserve_message_bytes_and_json_body_limit(self):
        def page(path, text):
            data = text.encode("utf-8")
            return wiki_remote.LocalPage(path, sha(data), len(data), text)

        def ops(pages):
            return [(p, wiki_remote.upsert_op(p, None)) for p in pages]

        limit = wiki_remote.MAX_COMMIT_BYTES
        half = [page(f"p{i}.md", "a" * (limit // 2)) for i in range(2)]
        batches, too_large = wiki_remote.make_batches(ops(half), 25, limit, "wiki")
        self.assertEqual(([len(b) for b in batches], too_large), ([1, 1], []))
        for batch in batches:
            body = {"message": wiki_remote.import_message(len(batch), "wiki"), "ops": [op for _, op in batch]}
            content = sum(p.size for p, _ in batch) + len(body["message"].encode("utf-8"))
            self.assertLessEqual(content, limit)

        quotes = [page(f"q{i}.md", '"' * 1_400_000) for i in range(3)]
        batches, too_large = wiki_remote.make_batches(ops(quotes), 25, limit, "wiki")
        self.assertEqual(too_large, [])
        for batch in batches:
            body = {"message": wiki_remote.import_message(len(batch), "wiki"), "ops": [op for _, op in batch]}
            self.assertLess(wiki_remote.json_bytes(body), wiki_remote.MAX_JSON_BODY)
        self.assertEqual(sum(len(b) for b in batches), 3)

        control = page("c.md", "\x01" * 1_000_000)
        batches, too_large = wiki_remote.make_batches(ops([control]), 25, limit, "wiki")
        self.assertEqual((batches, [p.path for p in too_large]), ([], ["c.md"]))


class PullTests(RemoteTestCase):
    def pull(self, target: Path, *extra: str, expect: int = 0) -> dict:
        code, out, err = run_cli("--json", "pull", str(target), *extra)
        self.assertEqual(code, expect, msg=f"{out}\n{err}")
        return json.loads(out)

    def test_incremental_pull_and_delete(self):
        self.wiki.seed("a.md", "A1\n")
        self.wiki.seed("dir/b.md", "B1\n")
        target = self.tmp / "mirror"
        report = self.pull(target)
        self.assertEqual(sorted(report["written"]), ["a.md", "dir/b.md"])
        self.assertEqual((target / "a.md").read_text(), "A1\n")
        state = json.loads((target / ".llm-wiki-remote.json").read_text())
        self.assertEqual(state["seq"], 2)

        self.wiki.seed("a.md", "A2\n")
        self.wiki.seed("c.md", "C1\n")
        report = self.pull(target)
        self.assertEqual(report["from_seq"], 2)
        self.assertEqual(sorted(report["written"]), ["a.md", "c.md"])
        since = [q["since"] for m, p, q, _ in self.wiki.requests if p == "/api/v1/changes"]
        self.assertEqual(since[-1], "2")

        self.wiki.remove("dir/b.md")
        report = self.pull(target)
        self.assertEqual(report["deleted"], ["dir/b.md"])
        self.assertFalse((target / "dir").exists())
        self.assertEqual(self.pull(target)["written"], [])

    def test_pull_pages_through_many_changes(self):
        for i in range(450):
            self.wiki.seed(f"p/{i:03d}.md", f"page {i}\n")
        target = self.tmp / "mirror"
        report = self.pull(target)
        self.assertEqual(len(report["written"]), 450)
        self.assertEqual(report["to_seq"], 450)
        self.assertEqual(self.wiki.count("GET", "/api/v1/changes"), 3)

    def test_local_changes_are_kept(self):
        self.wiki.seed("a.md", "A1\n")
        self.wiki.seed("b.md", "B1\n")
        target = self.tmp / "mirror"
        self.pull(target)
        (target / "a.md").write_text("my local edit\n")
        (target / "b.md").write_text("my other edit\n")
        self.wiki.seed("a.md", "A2\n")
        self.wiki.remove("b.md")
        report = self.pull(target)
        self.assertEqual((target / "a.md").read_text(), "A2\n")
        self.assertFalse((target / "b.md").exists())
        copies = {c["path"]: c["saved_as"] for c in report["local_copies"]}
        self.assertEqual(set(copies), {"a.md", "b.md"})
        self.assertRegex(copies["a.md"], r"^a\.md\.local-\d{8}T\d{6}Z$")
        self.assertEqual((target / copies["a.md"]).read_text(), "my local edit\n")
        self.assertEqual((target / copies["b.md"]).read_text(), "my other edit\n")

    def test_existing_unknown_local_file_is_kept(self):
        target = self.tmp / "mirror"
        target.mkdir()
        (target / "a.md").write_text("pre-existing\n")
        self.wiki.seed("a.md", "server\n")
        report = self.pull(target)
        self.assertEqual(len(report["local_copies"]), 1)
        self.assertEqual((target / "a.md").read_text(), "server\n")

    def test_pull_refuses_other_wiki_state(self):
        self.wiki.seed("a.md", "A\n")
        target = self.tmp / "mirror"
        self.pull(target)
        state_path = target / ".llm-wiki-remote.json"
        state = json.loads(state_path.read_text())
        state["url"] = "https://other.example"
        state_path.write_text(json.dumps(state))
        code, _, err = run_cli("pull", str(target))
        self.assertEqual(code, 2)
        self.assertIn("other.example", err)

    @unittest.skipUnless(shutil.which("git"), "git is not installed")
    def test_pull_git_commit(self):
        target = self.tmp / "mirror"
        target.mkdir()
        subprocess.run(["git", "init", "-q", str(target)], check=True)
        env_keys = ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL")
        saved = {k: os.environ.get(k) for k in env_keys}
        os.environ.update({"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
                           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"})
        try:
            self.wiki.seed("a.md", "A1\n")
            report = self.pull(target, "--git", "--message", "mirror sync")
            self.assertTrue(report["git"]["committed"])
            log = subprocess.run(["git", "-C", str(target), "log", "--format=%s"], capture_output=True, text=True).stdout
            self.assertEqual(log.strip(), "mirror sync")
            files = subprocess.run(["git", "-C", str(target), "ls-files"], capture_output=True, text=True).stdout.split()
            self.assertEqual(files, ["a.md"])
            self.wiki.remove("a.md")
            report = self.pull(target, "--git")
            self.assertTrue(report["git"]["committed"])
            files = subprocess.run(["git", "-C", str(target), "ls-files"], capture_output=True, text=True).stdout.split()
            self.assertEqual(files, [])
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    @unittest.skipUnless(shutil.which("git"), "git is not installed")
    def test_pull_git_leaves_unrelated_staged_files(self):
        target = self.tmp / "mirror"
        target.mkdir()
        git_env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
                   "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}

        def git(*cmd):
            return subprocess.run(["git", "-C", str(target), *cmd], capture_output=True, text=True,
                                  env=git_env, check=True).stdout

        git("init", "-q")
        (target / "seed.txt").write_text("seed\n")
        git("add", "seed.txt")
        git("commit", "-q", "-m", "seed")
        (target / "notes.txt").write_text("my staged work\n")
        git("add", "notes.txt")
        saved = {k: os.environ.get(k) for k in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
                                                  "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL")}
        os.environ.update({k: git_env[k] for k in saved})
        try:
            self.wiki.seed("a.md", "A1\n")
            self.wiki.seed("b[1].md", "B1\n")
            report = self.pull(target, "--git", "--message", "mirror sync")
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.assertTrue(report["git"]["committed"])
        in_commit = git("show", "--name-only", "--format=", "HEAD").split()
        self.assertEqual(sorted(in_commit), ["a.md", "b[1].md"])
        self.assertEqual(git("diff", "--cached", "--name-only").split(), ["notes.txt"])

    def test_pull_git_outside_repo_warns(self):
        self.wiki.seed("a.md", "A1\n")
        target = self.tmp / "plain"
        report = self.pull(target, "--git")
        self.assertFalse(report["git"]["committed"])

    def test_pull_refuses_symlinked_folder(self):
        self.wiki.seed("notes/b.md", "B1\n")
        target = self.tmp / "mirror"
        self.pull(target)
        outside = self.tmp / "outside"
        outside.mkdir()
        (outside / "b.md").write_text("B1\n")
        shutil.rmtree(target / "notes")
        (target / "notes").symlink_to(outside, target_is_directory=True)
        # A delete through the link must not remove the file outside the mirror.
        self.wiki.remove("notes/b.md")
        code, _, err = run_cli("pull", str(target))
        self.assertEqual(code, 1)
        self.assertIn("symbolic link", err)
        self.assertEqual((outside / "b.md").read_text(), "B1\n")
        # A write through a link must not create a file outside the mirror.
        fresh = self.tmp / "mirror2"
        fresh.mkdir()
        (fresh / "docs").symlink_to(outside, target_is_directory=True)
        wiki2 = FakeWiki()
        wiki2.seed("docs/new.md", "N\n")
        self.wiki.__dict__.update(wiki2.__dict__)
        code, _, err = run_cli("pull", str(fresh))
        self.assertEqual(code, 1)
        self.assertIn("symbolic link", err)
        self.assertFalse((outside / "new.md").exists())

    def test_pull_refuses_symlinked_state_file(self):
        self.wiki.seed("a.md", "A1\n")
        target = self.tmp / "mirror"
        target.mkdir()
        outside = self.tmp / "outside-state.json"
        secret = json.dumps({"url": self.url, "wiki": "main", "seq": 0, "files": {}, "keep": "me"})
        outside.write_text(secret)
        (target / wiki_remote.PULL_STATE_FILE).symlink_to(outside)
        code, _, err = run_cli("pull", str(target))
        self.assertEqual(code, 1)
        self.assertIn("symbolic link", err)
        # Nothing was read through the link, written through it, or pulled.
        self.assertEqual(outside.read_text(), secret)
        self.assertTrue((target / wiki_remote.PULL_STATE_FILE).is_symlink())
        self.assertFalse((target / "a.md").exists())

    def test_move_page_onto_its_old_folder_name(self):
        self.wiki.seed("notes/a.md", "A1\n")
        target = self.tmp / "mirror"
        self.pull(target)
        self.wiki.move("notes/a.md", "notes")
        report = self.pull(target)
        self.assertEqual(report["deleted"], ["notes/a.md"])
        self.assertEqual(report["written"], ["notes"])
        self.assertEqual((target / "notes").read_text(), "A1\n")

    def test_move_onto_folder_keeps_unrelated_local_files(self):
        self.wiki.seed("notes/a.md", "A1\n")
        target = self.tmp / "mirror"
        self.pull(target)
        (target / "notes" / "mine.txt").write_text("my file\n")
        self.wiki.move("notes/a.md", "notes")
        report = self.pull(target, expect=1)
        self.assertEqual((target / "notes" / "mine.txt").read_text(), "my file\n")
        self.assertFalse((target / "notes" / "a.md").exists())
        self.assertTrue(any("notes" in w for w in report["warnings"]))

    def test_local_copies_in_the_same_second_do_not_replace_each_other(self):
        original = wiki_remote.utc_stamp
        wiki_remote.utc_stamp = lambda: "20261029T000000Z"
        try:
            self.wiki.seed("a.md", "A1\n")
            target = self.tmp / "mirror"
            self.pull(target)
            copies = []
            for i in (1, 2):
                (target / "a.md").write_text(f"local edit {i}\n")
                self.wiki.seed("a.md", f"A{i + 1}\n")
                copies += [c["saved_as"] for c in self.pull(target)["local_copies"]]
        finally:
            wiki_remote.utc_stamp = original
        self.assertEqual(copies, ["a.md.local-20261029T000000Z", "a.md.local-20261029T000000Z-1"])
        self.assertEqual((target / copies[0]).read_text(), "local edit 1\n")
        self.assertEqual((target / copies[1]).read_text(), "local edit 2\n")
        self.assertTrue(wiki_remote.LOCAL_COPY_RE.search(copies[1]))


class ExportAndApiTests(RemoteTestCase):
    def test_export_tarball(self):
        self.wiki.seed("a.md", "A\n")
        self.wiki.seed("dir/b.md", "B caf\u00e9\n")
        out = self.tmp / "wiki.tar.gz"
        code, stdout, err = run_cli("--json", "export", str(out))
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(stdout)["pages"], 2)
        with tarfile.open(out, "r:gz") as tar:
            names = sorted(tar.getnames())
            self.assertEqual(names, [".llm-wiki-export.json", "a.md", "dir/b.md"])
            self.assertEqual(tar.extractfile("dir/b.md").read().decode("utf-8"), "B caf\u00e9\n")
            meta = json.loads(tar.extractfile(".llm-wiki-export.json").read())
            self.assertEqual(meta["seq"], 2)
            self.assertEqual(meta["pages"]["a.md"], sha("A\n"))

    def test_export_truncated_stream_fails(self):
        self.wiki.seed("a.md", "A\n")
        self.wiki.truncate_export = True
        out = self.tmp / "wiki.tar.gz"
        code, _, err = run_cli("export", str(out))
        self.assertEqual(code, 1)
        self.assertIn("end marker", err)
        self.assertFalse(out.exists())
        self.assertFalse(Path(str(out) + ".part").exists())

    def test_commit_conflict_exit_3(self):
        self.wiki.seed("a.md", "A\n")
        ops = self.tmp / "ops.json"
        ops.write_text(json.dumps({"message": "edit", "ops": [{"op": "put", "path": "a.md", "content": "X", "base_rev": 99}]}))
        code, out, err = run_cli("commit", str(ops))
        self.assertEqual(code, 3)
        self.assertIn("Conflict", err)
        details = json.loads(out)["error"]["details"]
        self.assertEqual(details["reason"], "stale_base_rev")
        self.assertEqual(details["current_rev"], 1)
        self.assertEqual(self.wiki.commit_calls, 1)

    def test_commit_from_stdin_list(self):
        code, out, err = run_cli("commit", "-", "--message", "add", stdin=json.dumps([{"op": "create", "path": "n.md", "content": "N\n"}]))
        self.assertEqual(code, 0, err)
        self.assertIn("n.md", out)
        self.assertEqual(self.wiki.pages["n.md"]["content"], "N\n")

    def test_commit_without_message_is_usage_error(self):
        code, _, _ = run_cli("commit", "-", stdin="[]")
        self.assertEqual(code, 2)

    def test_retry_on_503_for_get(self):
        self.wiki.fail_next[("GET", "/api/v1/whoami")] = [503, 503]
        code, _, err = run_cli("status")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.wiki.count("GET", "/api/v1/whoami"), 3)

    def test_retry_gives_up(self):
        self.wiki.fail_next[("GET", "/api/v1/whoami")] = [503] * 10
        code, _, _ = run_cli("status")
        self.assertEqual(code, 1)
        self.assertEqual(self.wiki.count("GET", "/api/v1/whoami"), len(wiki_remote.RETRY_DELAYS) + 1)

    def test_no_retry_for_plain_commit(self):
        self.wiki.fail_next[("POST", "/api/v1/commit")] = [503]
        code, _, _ = run_cli("commit", "-", "--message", "m", stdin=json.dumps([{"op": "create", "path": "x.md", "content": "x"}]))
        self.assertEqual(code, 1)
        self.assertEqual(self.wiki.count("POST", "/api/v1/commit"), 1)

    def test_search_read_raw(self):
        self.wiki.seed("a.md", "Kalman filter notes\n")
        code, out, _ = run_cli("--json", "search", "kalman", "--lexical", "--top", "3")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["results"][0]["rel_path"], "a.md")
        body = [r for r in self.wiki.requests if r[1] == "/api/v1/search"]
        self.assertTrue(body)
        code, out, _ = run_cli("read", "a.md")
        self.assertEqual((code, out), (0, "Kalman filter notes\n"))
        code, _, err = run_cli("read", "a.md", "missing.md")
        self.assertEqual(code, 1)
        self.assertIn("missing.md", err)

        src = self.tmp / "doc.txt"
        src.write_bytes(b"raw bytes\n")
        code, _, err = run_cli("raw", "put", str(src), "--as", "docs/doc.txt")
        self.assertEqual(code, 0, err)
        code, out, _ = run_cli("raw", "ls", "docs/")
        self.assertIn("docs/doc.txt", out)
        dest = self.tmp / "back.txt"
        code, _, _ = run_cli("raw", "get", "docs/doc.txt", "-o", str(dest))
        self.assertEqual((code, dest.read_bytes()), (0, b"raw bytes\n"))
        src.write_bytes(b"changed\n")
        code, _, _ = run_cli("raw", "put", str(src), "--as", "docs/doc.txt")
        self.assertEqual(code, 3)


class McpConfigTests(RemoteTestCase):
    def test_outputs_never_leak_token(self):
        for client in wiki_remote.MCP_CLIENTS:
            for json_flag in ((), ("--json",)):
                code, out, err = run_cli(*json_flag, "mcp-config", client)
                self.assertEqual(code, 0, err)
                self.assertNotIn(TOKEN, out + err, client)
                self.assertIn(self.url + "/mcp", out, client)

    def test_client_syntax(self):
        def snippet(client):
            code, out, _ = run_cli("mcp-config", client)
            self.assertEqual(code, 0)
            return out

        claude = snippet("claude-code")
        self.assertEqual(
            claude.strip(),
            f'claude mcp add --transport http llm-wiki {self.url}/mcp --header "Authorization: Bearer ${{LLM_WIKI_TOKEN}}"',
        )
        codex = snippet("codex")
        self.assertIn("[mcp_servers.llm-wiki]", codex)
        self.assertIn(f'url = "{self.url}/mcp"', codex)
        self.assertIn('bearer_token_env_var = "LLM_WIKI_TOKEN"', codex)
        cursor = json.loads(snippet("cursor"))["mcpServers"]["llm-wiki"]
        self.assertEqual(cursor, {"url": f"{self.url}/mcp", "headers": {"Authorization": "Bearer ${env:LLM_WIKI_TOKEN}"}})
        gemini = json.loads(snippet("gemini"))["mcpServers"]["llm-wiki"]
        self.assertEqual(gemini["httpUrl"], f"{self.url}/mcp")
        self.assertEqual(gemini["headers"]["Authorization"], "Bearer ${LLM_WIKI_TOKEN}")
        opencode = json.loads(snippet("opencode"))["mcp"]["llm-wiki"]
        self.assertEqual(opencode["type"], "remote")
        self.assertEqual(opencode["headers"]["Authorization"], "Bearer {env:LLM_WIKI_TOKEN}")
        omp = json.loads(snippet("omp"))["mcpServers"]["llm-wiki"]
        self.assertEqual(omp["type"], "http")
        generic = json.loads(snippet("generic"))["mcpServers"]["llm-wiki"]
        self.assertEqual(generic["url"], f"{self.url}/mcp")

    def test_show_token_and_wiki_header(self):
        code, out, _ = run_cli("--wiki", "team", "mcp-config", "cursor", "--show-token")
        self.assertEqual(code, 0)
        server = json.loads(out)["mcpServers"]["llm-wiki"]
        self.assertEqual(server["headers"], {"Authorization": f"Bearer {TOKEN}", "X-LLM-Wiki": "team"})
        code, out, _ = run_cli("mcp-config", "codex", "--show-token")
        self.assertIn(TOKEN, out)
        self.assertNotIn("bearer_token_env_var", out)

    def test_mcp_config_needs_no_token(self):
        os.environ.pop("LLM_WIKI_TOKEN")
        code, out, _ = run_cli("mcp-config", "gemini")
        self.assertEqual(code, 0)
        code, _, _ = run_cli("mcp-config", "gemini", "--show-token")
        self.assertEqual(code, 2)

    def test_bad_client_is_usage_error(self):
        code, _, _ = run_cli("mcp-config", "notepad")
        self.assertEqual(code, 2)

    def test_pi_and_omp_targets(self):
        def target(client):
            code, out, _ = run_cli("--json", "mcp-config", client)
            self.assertEqual(code, 0)
            return json.loads(out)

        pi = target("pi")
        self.assertIn("~/.pi/agent/mcp.json", pi["target"])
        self.assertIn(".pi/mcp.json", pi["target"])
        self.assertNotIn("omp", pi["target"])
        self.assertFalse(any("adapter" in n.lower() for n in pi["notes"]))
        server = json.loads(pi["snippet"])["mcpServers"]["llm-wiki"]
        self.assertEqual(server["headers"]["Authorization"], "Bearer ${LLM_WIKI_TOKEN}")
        omp = target("omp")
        self.assertIn("~/.omp/agent/mcp.json", omp["target"])
        self.assertIn(".omp/mcp.json", omp["target"])


class HelpTextTests(unittest.TestCase):
    def test_no_em_dash_in_files(self):
        for path in (SCRIPT, Path(__file__)):
            self.assertNotIn("\u2014", path.read_text(encoding="utf-8"), str(path))

    def test_help_sentences_are_short(self):
        parser = wiki_remote.build_parser()
        texts = [parser.format_help()]
        for action in parser._subparsers._group_actions:  # noqa: SLF001 - test only
            for sub in action.choices.values():
                texts.append(sub.format_help())
        for text in texts:
            self.assertNotIn("honest", text.lower())
            for sentence in text.replace("\n", " ").split(". "):
                self.assertLessEqual(len(sentence.split()), 60)  # usage lines are long; prose is checked below
        for action in parser._subparsers._group_actions:  # noqa: SLF001
            for name, sub in action.choices.items():
                prose = [sub.description or ""] + [a.help or "" for a in sub._actions]  # noqa: SLF001
                for item in prose:
                    for sentence in item.split(". "):
                        self.assertLessEqual(len(sentence.split()), 25, f"{name}: {sentence}")


if __name__ == "__main__":
    unittest.main(verbosity=1)
