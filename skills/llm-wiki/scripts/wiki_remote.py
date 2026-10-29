#!/usr/bin/env python3
"""
wiki_remote.py - Command-line client for a hosted LLM Wiki server (v4).

Uses only the Python standard library (Python 3.10 or later).

The client connects to the JSON API of a hosted wiki (`/api/v1`). It moves a
local wiki to the server (`import`), keeps a pull-only mirror (`pull`), makes
a tarball of all pages (`export`), uploads raw files, and prints MCP
configuration for agent clients.

Configuration:
    ~/.config/llm-wiki/remote.json (mode 0600):
        {"default": "<name>", "profiles": {"<name>": {"url": ..., "token": ..., "wiki": ...}}}
    Environment: LLM_WIKI_URL, LLM_WIKI_TOKEN, LLM_WIKI_CONFIG (other config file).
    An explicit --profile wins over the environment. The environment wins
    over the default profile.

Exit codes: 0 success, 1 failure, 2 usage error, 3 conflict.

Usage:
    python3 wiki_remote.py login --url https://wiki.example.workers.dev --token lw_main_...
    python3 wiki_remote.py import ~/wiki --dry-run
    python3 wiki_remote.py pull ~/wiki-mirror --git
    python3 wiki_remote.py mcp-config codex
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import http.client
import io
import json
import mimetypes
import os
import re
import shlex
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

VERSION = "4.0.1"
USER_AGENT = f"llm-wiki-remote/{VERSION}"

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2
EXIT_CONFLICT = 3

URL_ENV = "LLM_WIKI_URL"
TOKEN_ENV = "LLM_WIKI_TOKEN"
CONFIG_ENV = "LLM_WIKI_CONFIG"

# Server limits (see the v4 commit rules).
MAX_PAGE_BYTES = 1_500_000
MAX_COMMIT_OPS = 200
MAX_COMMIT_BYTES = 4_000_000
# Largest JSON request body the server API reads. JSON escapes make it larger than the content.
MAX_JSON_BODY = 5 * 1024 * 1024
MAX_PATH_BYTES = 512
CHANGES_LIMIT = 200

# Delays (seconds) between retries of idempotent requests. Tests set zeros.
RETRY_DELAYS: tuple[float, ...] = (0.5, 1.0, 2.0, 4.0)
MAX_RETRY_AFTER = 30.0
TIMEOUT = 60

TEMPLATE_RE = re.compile(r"^\.[a-z0-9-]+-template\.(md|json)$")
LOCAL_COPY_RE = re.compile(r"\.local-\d{8}T\d{6}Z(-\d+)?$")
# Under top-level graph/ only the ontology and Markdown notes are source files.
# wiki_graph_extract.py makes the other files there (jsonl, sqlite, graphml).
GRAPH_SOURCE_RE = re.compile(r"^graph/(ontology\.ya?ml|.*\.md)$")
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")
PULL_STATE_FILE = ".llm-wiki-remote.json"
EXPORT_MANIFEST = ".llm-wiki-export.json"


# ---------------------------------------------------------------------------
# Errors and output
# ---------------------------------------------------------------------------


class CliError(Exception):
    """A failure that ends the command with an exit code."""

    def __init__(self, message: str, exit_code: int = EXIT_FAIL):
        super().__init__(message)
        self.exit_code = exit_code


class ApiFailure(CliError):
    """An error response from the server (`{error: {code, message, details}}`)."""

    def __init__(self, status: int, code: str, message: str, details=None):
        super().__init__(message, EXIT_CONFLICT if status == 409 else EXIT_FAIL)
        self.status = status
        self.code = code
        self.details = details


def note(message: str) -> None:
    print(message, file=sys.stderr)


def print_json(data) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def atomic_write_bytes(path: str, data: bytes, mode: int | None = None) -> None:
    """Write `data` to a temp file in the same folder, then rename it into place."""
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=parent, prefix=".tmp-llm-wiki-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def atomic_write_json(path: str, data, mode: int | None = None) -> None:
    text = json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    atomic_write_bytes(path, text.encode("utf-8"), mode)


def load_json_file(path: str):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise CliError(f"Cannot read {path}: {exc}")


def path_problem(rel: str) -> str | None:
    """Return a reason when the server will refuse this relative path."""
    if not rel or rel.startswith("/") or "\\" in rel:
        return "invalid_path"
    if CONTROL_RE.search(rel):
        return "invalid_path"
    if len(rel.encode("utf-8")) > MAX_PATH_BYTES:
        return "path_too_long"
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return "invalid_path"
    for i, part in enumerate(parts):
        if part.startswith("."):
            if i == 0 and len(parts) == 1 and TEMPLATE_RE.match(part):
                continue
            return "invalid_path"
    return None


def check_server_path(rel: str) -> list[str]:
    """Return the parts of a server path. Refuse paths that can leave a folder."""
    if not rel or rel.startswith("/") or "\\" in rel or CONTROL_RE.search(rel):
        raise CliError(f"The server sent an unsafe path: {rel!r}")
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise CliError(f"The server sent an unsafe path: {rel!r}")
    return parts


def safe_join(root: str, rel: str) -> str:
    """Join a server path to a local folder. Refuse paths that leave the folder.

    Every part of the path below `root` must not be a symbolic link, and the
    real parent folder must stay inside the real `root`. Call this before each
    read, write, rename, or delete in the folder.
    """
    parts = check_server_path(rel)
    path = root
    for part in parts:
        path = os.path.join(path, part)
        if os.path.islink(path):
            raise CliError(f"Refused {rel}: {path} is a symbolic link.")
    real_root = os.path.realpath(root)
    real_parent = os.path.realpath(os.path.dirname(path))
    if os.path.commonpath([real_root, real_parent]) != real_root:
        raise CliError(f"Refused {rel}: the path leaves {root}.")
    return path


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def config_path() -> str:
    override = os.environ.get(CONFIG_ENV)
    if override:
        return os.path.abspath(os.path.expanduser(override))
    return os.path.join(os.path.expanduser("~"), ".config", "llm-wiki", "remote.json")


def state_dir() -> str:
    return os.path.join(os.path.dirname(config_path()), "state")


def load_config() -> dict:
    path = config_path()
    data = load_json_file(path)
    if data is None:
        return {"default": None, "profiles": {}}
    if os.name == "posix":
        mode = os.stat(path).st_mode & 0o777
        if mode & 0o077:
            note(f"Warning: {path} has mode {mode:o}. Run: chmod 600 {shlex.quote(path)}")
    if not isinstance(data, dict):
        raise CliError(f"{path} is not a JSON object.")
    data.setdefault("default", None)
    data.setdefault("profiles", {})
    return data


def save_config(cfg: dict) -> str:
    path = config_path()
    folder = os.path.dirname(path)
    if not os.path.isdir(folder):
        os.makedirs(folder, mode=0o700, exist_ok=True)
    atomic_write_json(path, cfg, mode=0o600)
    return path


def normalize_url(url: str) -> str:
    url = url.strip().rstrip("/")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise CliError(f"The URL must start with https:// or http://: {url}", EXIT_USAGE)
    if parsed.path.endswith("/mcp"):
        url = url[: -len("/mcp")]
    return url


def resolve_connection(args, need_token: bool = True) -> tuple[str, str | None, str | None, str | None]:
    """Return (url, token, wiki, profile name) for this command."""
    cfg = load_config()
    explicit = getattr(args, "profile", None)
    name = explicit or cfg.get("default")
    prof = cfg["profiles"].get(name) if name else None
    if explicit and prof is None:
        raise CliError(f"Profile '{explicit}' does not exist. Run the login command first.", EXIT_USAGE)
    prof = prof or {}
    if explicit:
        url, token = prof.get("url"), prof.get("token")
    else:
        url = os.environ.get(URL_ENV) or prof.get("url")
        token = os.environ.get(TOKEN_ENV) or prof.get("token")
    if getattr(args, "url_override", None):
        url = args.url_override
    wiki = getattr(args, "wiki", None) or prof.get("wiki")
    if not url:
        raise CliError(
            f"No server URL is set. Run the login command, or set {URL_ENV} and {TOKEN_ENV}.", EXIT_USAGE
        )
    if need_token and not token:
        raise CliError(f"No token is set. Run the login command, or set {TOKEN_ENV}.", EXIT_USAGE)
    return normalize_url(url), token, wiki, name


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------


def _retry_after(headers) -> float | None:
    value = headers.get("Retry-After") if headers is not None else None
    if not value:
        return None
    try:
        return min(max(float(value), 0.0), MAX_RETRY_AFTER)
    except ValueError:
        return None


def _api_failure(err: urllib.error.HTTPError) -> ApiFailure:
    status = err.code
    try:
        body = err.read()
    except Exception:  # noqa: BLE001 - the body is optional
        body = b""
    code, message, details = "http_error", f"HTTP {status} {err.reason}", None
    try:
        payload = json.loads(body.decode("utf-8")) if body else None
    except (ValueError, UnicodeDecodeError):
        payload = None
    if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
        e = payload["error"]
        code = str(e.get("code") or code)
        message = str(e.get("message") or message)
        details = e.get("details")
    return ApiFailure(status, code, message, details)


class Client:
    def __init__(self, url: str, token: str | None, wiki: str | None = None):
        self.base = url.rstrip("/")
        self.token = token
        self.wiki = wiki

    def url_for(self, path: str, query: dict | None = None) -> str:
        url = self.base + path
        if query:
            clean = {k: v for k, v in query.items() if v is not None}
            if clean:
                url += "?" + urllib.parse.urlencode(clean)
        return url

    def open(
        self,
        method: str,
        path: str,
        query: dict | None = None,
        body=None,
        data: bytes | None = None,
        headers: dict | None = None,
        idempotent: bool | None = None,
    ):
        """Send one request and return the open response. Retry idempotent requests."""
        if idempotent is None:
            idempotent = method in ("GET", "HEAD", "PUT", "DELETE")
        hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        if self.token:
            hdrs["Authorization"] = f"Bearer {self.token}"
        if self.wiki:
            hdrs["X-LLM-Wiki"] = self.wiki
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        if headers:
            hdrs.update(headers)
        url = self.url_for(path, query)
        attempt = 0
        while True:
            req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
            try:
                return urllib.request.urlopen(req, timeout=TIMEOUT)
            except urllib.error.HTTPError as err:
                retryable = err.code == 429 or err.code >= 500
                if idempotent and retryable and attempt < len(RETRY_DELAYS):
                    delay = _retry_after(err.headers)
                    err.close()
                    time.sleep(RETRY_DELAYS[attempt] if delay is None else delay)
                    attempt += 1
                    continue
                raise _api_failure(err) from None
            except (urllib.error.URLError, http.client.HTTPException, ConnectionError, socket.timeout, TimeoutError) as err:
                if idempotent and attempt < len(RETRY_DELAYS):
                    time.sleep(RETRY_DELAYS[attempt])
                    attempt += 1
                    continue
                reason = getattr(err, "reason", err)
                raise CliError(f"Cannot reach {self.base}: {reason}") from None

    def call(self, method: str, path: str, query=None, body=None, idempotent: bool | None = None):
        """Send a JSON request and return the decoded JSON response."""
        with self.open(method, path, query=query, body=body, idempotent=idempotent) as resp:
            raw = resp.read()
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise CliError(f"The server sent a response that is not JSON for {method} {path}.")

    def get(self, route: str, /, **query):
        # `route` is positional-only, so a query parameter named `path` works.
        return self.call("GET", route, query=query or None)

    def post(self, path: str, body, idempotent: bool = False):
        return self.call("POST", path, body=body, idempotent=idempotent)


def make_client(args, need_token: bool = True) -> Client:
    url, token, wiki, _ = resolve_connection(args, need_token)
    return Client(url, token, wiki)


def raw_url_path(rel: str) -> str:
    return "/api/v1/raw/" + urllib.parse.quote(rel, safe="/")


# ---------------------------------------------------------------------------
# login, status, admin commands
# ---------------------------------------------------------------------------


def cmd_login(args) -> int:
    raw_url = args.login_url or getattr(args, "url_override", None) or os.environ.get(URL_ENV)
    if not raw_url:
        raise CliError("Give the server URL with --url.", EXIT_USAGE)
    url = normalize_url(raw_url)
    token = args.token
    if token == "-":
        token = sys.stdin.readline().strip()
    elif not token:
        token = os.environ.get(TOKEN_ENV) or getpass.getpass("Token: ").strip()
    if not token:
        raise CliError("No token was given.", EXIT_USAGE)
    wiki = getattr(args, "wiki", None)
    who = Client(url, token, wiki).get("/api/v1/whoami")
    cfg = load_config()
    name = args.profile or cfg.get("default") or "default"
    profile = {"url": url, "token": token}
    if wiki:
        profile["wiki"] = wiki
    cfg["profiles"][name] = profile
    if not cfg.get("default"):
        cfg["default"] = name
    path = save_config(cfg)
    if args.json:
        print_json({"profile": name, "url": url, "config": path, "whoami": who})
    else:
        scopes = ", ".join(who.get("scopes") or [])
        print(f"Signed in to {url} as '{who.get('label')}' on wiki '{who.get('wiki')}'.")
        print(f"Scopes: {scopes or 'none'}. Admin: {'yes' if who.get('admin') else 'no'}.")
        print(f"Profile '{name}' is saved in {path}.")
    return EXIT_OK


def cmd_status(args) -> int:
    url, token, wiki, name = resolve_connection(args)
    client = Client(url, token, wiki)
    who = client.get("/api/v1/whoami")
    overview = client.get("/api/v1/overview")
    if args.json:
        print_json({"profile": name, "url": url, "whoami": who, "overview": overview})
        return EXIT_OK
    print(f"Server:   {url}")
    print(f"Profile:  {name or '(environment)'}")
    print(f"Wiki:     {who.get('wiki')}")
    print(f"Identity: {who.get('label')} (scopes: {', '.join(who.get('scopes') or [])})")
    if isinstance(overview, dict):
        print(f"Version:  {overview.get('server_version')}")
        print(f"Seq:      {overview.get('seq')}")
        print(f"Pages:    {overview.get('pages')} ({overview.get('sections')} sections, {overview.get('bytes')} bytes)")
        print(f"Vectors:  {'on' if overview.get('vectors_enabled') else 'off'} (lag {overview.get('vector_lag')})")
        print(f"Raw:      {'on' if overview.get('raw_enabled') else 'off'}")
        dec = overview.get("decisions") or {}
        state = "on" if dec.get("enabled") else "off"
        print(f"Decisions: {state} ({dec.get('backend')}, {dec.get('model')})")
        print(f"Open review flags: {overview.get('open_review_flags')}")
    return EXIT_OK


def parse_scopes(value: str) -> list[str]:
    scopes = [s.strip() for s in value.split(",") if s.strip()]
    allowed = {"read", "write", "raw:write", "admin"}
    bad = [s for s in scopes if s not in allowed]
    if not scopes or bad:
        raise CliError(f"Scopes must be a comma list of {', '.join(sorted(allowed))}.", EXIT_USAGE)
    return scopes


def cmd_wiki(args) -> int:
    client = make_client(args)
    if args.wiki_action == "create":
        result = client.post("/api/v1/admin/wikis", {"id": args.id})
        if args.json:
            print_json(result)
        else:
            created = result.get("created") if isinstance(result, dict) else None
            print(f"Wiki '{args.id}' {'is created' if created else 'exists'}.")
        return EXIT_OK
    result = client.get("/api/v1/admin/wikis")
    if args.json:
        print_json(result)
    else:
        for w in result or []:
            print(f"{w.get('id')}\tcreated {w.get('created_at')} by {w.get('created_by')}")
    return EXIT_OK


def cmd_token(args) -> int:
    client = make_client(args)
    wiki = getattr(args, "wiki", None)
    if args.token_action == "create":
        body = {"label": args.label, "scopes": parse_scopes(args.scopes)}
        if wiki:
            body["wiki"] = wiki
        result = client.post("/api/v1/admin/tokens", body)
        if args.json:
            print_json(result)
        else:
            info = result.get("info") or {}
            print(result.get("token"))
            note(f"Token '{info.get('label')}' ({info.get('id')}) has scopes {', '.join(info.get('scopes') or [])}.")
            note("Keep this token secret. The server does not show it again.")
        return EXIT_OK
    if args.token_action == "list":
        result = client.get("/api/v1/admin/tokens", wiki=wiki)
        if args.json:
            print_json(result)
        else:
            for t in result or []:
                state = "revoked" if t.get("revoked_at") else "active"
                print(f"{t.get('id')}\t{t.get('label')}\t{','.join(t.get('scopes') or [])}\t{state}\tlast used {t.get('last_used_at') or 'never'}")
        return EXIT_OK
    path = "/api/v1/admin/tokens/" + urllib.parse.quote(args.id, safe="")
    result = client.call("DELETE", path, query={"wiki": wiki})
    if args.json:
        print_json(result if result is not None else {"revoked": args.id})
    else:
        print(f"Token {args.id} is revoked.")
    return EXIT_OK


def cmd_pair(args) -> int:
    client = make_client(args)
    body = {"label": args.label, "scopes": parse_scopes(args.scopes)}
    wiki = getattr(args, "wiki", None)
    if wiki:
        body["wiki"] = wiki
    result = client.post("/api/v1/admin/pairing-codes", body)
    if args.json:
        print_json(result)
    else:
        print(result.get("code"))
        note(f"The code expires at {result.get('expires_at')}. Enter it on the server sign-in page.")
    return EXIT_OK


# ---------------------------------------------------------------------------
# import
# ---------------------------------------------------------------------------


class LocalPage:
    __slots__ = ("path", "sha", "size", "text")

    def __init__(self, path: str, sha: str, size: int, text: str):
        self.path = path
        self.sha = sha
        self.size = size
        self.text = text


def scan_pages(wiki_dir: str, exclude_dirs: set[str]) -> tuple[list[LocalPage], list[dict]]:
    """Walk a local wiki with the server exclusion rules. Never writes."""
    pages: list[LocalPage] = []
    skipped: list[dict] = []
    for root, dirs, files in os.walk(wiki_dir):
        rel_root = os.path.relpath(root, wiki_dir)
        top = rel_root == "."
        keep = []
        for d in sorted(dirs):
            full = os.path.join(root, d)
            if d.startswith("."):
                continue
            if top and d == "raw":
                continue
            if os.path.abspath(full) in exclude_dirs:
                continue
            if os.path.islink(full):
                skipped.append({"path": d if top else f"{rel_root}/{d}".replace(os.sep, "/"), "reason": "symlink"})
                continue
            keep.append(d)
        dirs[:] = keep
        for f in sorted(files):
            rel = f if top else f"{rel_root}/{f}".replace(os.sep, "/")
            if f.startswith(".") and not (top and TEMPLATE_RE.match(f)):
                continue
            if LOCAL_COPY_RE.search(f):
                continue
            if rel.startswith("graph/") and not GRAPH_SOURCE_RE.match(rel):
                skipped.append({"path": rel, "reason": "generated"})
                continue
            full = os.path.join(root, f)
            if os.path.islink(full):
                skipped.append({"path": rel, "reason": "symlink"})
                continue
            reason = path_problem(rel)
            if reason:
                skipped.append({"path": rel, "reason": reason})
                continue
            size = os.path.getsize(full)
            if size > MAX_PAGE_BYTES:
                skipped.append({"path": rel, "reason": "too_large", "bytes": size})
                continue
            with open(full, "rb") as fh:
                data = fh.read()
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                skipped.append({"path": rel, "reason": "not_utf8"})
                continue
            if "\x00" in text:
                skipped.append({"path": rel, "reason": "not_text"})
                continue
            pages.append(LocalPage(rel, sha256_bytes(data), len(data), text))
    pages.sort(key=lambda p: p.path)
    return pages, skipped


def scan_raw(raw_dir: str) -> tuple[list[dict], list[dict]]:
    files: list[dict] = []
    skipped: list[dict] = []
    for root, dirs, names in os.walk(raw_dir):
        rel_root = os.path.relpath(root, raw_dir)
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and not os.path.islink(os.path.join(root, d)))
        for f in sorted(names):
            if f.startswith("."):
                continue
            rel = f if rel_root == "." else f"{rel_root}/{f}".replace(os.sep, "/")
            full = os.path.join(root, f)
            if os.path.islink(full):
                skipped.append({"path": rel, "reason": "symlink"})
                continue
            reason = path_problem(rel)
            if reason:
                skipped.append({"path": rel, "reason": reason})
                continue
            files.append({"path": rel, "abs": full, "bytes": os.path.getsize(full), "sha256": sha256_file(full)})
    files.sort(key=lambda r: r["path"])
    return files, skipped


def upsert_op(page: LocalPage, expected: str | None) -> dict:
    """An upsert with a precondition: None means the page must not exist yet."""
    return {"op": "upsert", "path": page.path, "content": page.text, "expected_sha256": expected}


def json_bytes(value) -> int:
    # Same encoding as Client.open, so the count matches the request body.
    return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))


def import_message(count: int, name: str) -> str:
    return f"import: {count} pages from {name}"


def make_batches(
    items: list[tuple[LocalPage, dict]], max_files: int, max_bytes: int, name: str
) -> tuple[list[list[tuple[LocalPage, dict]]], list[LocalPage]]:
    """Split upserts into commits. Return (batches, pages too large for one request).

    The server counts the message in its commit byte limit, so the content of
    a batch gets at most `max_bytes` minus the message. The JSON body of each
    request also stays below MAX_JSON_BODY.
    """
    message_bytes = len(import_message(max_files, name).encode("utf-8"))
    content_limit = min(max_bytes, MAX_COMMIT_BYTES - message_bytes)
    envelope = json_bytes({"message": import_message(max_files, name), "ops": []})
    batches: list[list[tuple[LocalPage, dict]]] = []
    too_large: list[LocalPage] = []
    current: list[tuple[LocalPage, dict]] = []
    size = 0
    body = envelope
    for page, op in items:
        op_body = json_bytes(op) + 2  # 2 bytes for the ", " separator
        if envelope + op_body > MAX_JSON_BODY or page.size > MAX_COMMIT_BYTES - message_bytes:
            too_large.append(page)
            continue
        if current and (
            len(current) >= max_files or size + page.size > content_limit or body + op_body > MAX_JSON_BODY
        ):
            batches.append(current)
            current, size, body = [], 0, envelope
        current.append((page, op))
        size += page.size
        body += op_body
    if current:
        batches.append(current)
    return batches, too_large


def import_state_path(url: str, wiki: str, wiki_dir: str) -> str:
    key = sha256_bytes(f"{url}\n{wiki}\n{wiki_dir}".encode("utf-8"))[:16]
    return os.path.join(state_dir(), f"import-{key}.json")


def remote_raw_index(client: Client) -> dict[str, str] | None:
    """Return {path: sha256} of remote raw files, or None when raw storage is off."""
    try:
        entries = client.get("/api/v1/raw", prefix="")
    except ApiFailure as exc:
        if exc.status == 503:
            return None
        raise
    return {e["path"]: e["sha256"] for e in entries or []}


def put_raw(client: Client, rel: str, data: bytes, sha: str, content_type: str | None = None):
    ctype = content_type or mimetypes.guess_type(rel)[0] or "application/octet-stream"
    with client.open(
        "PUT",
        raw_url_path(rel),
        data=data,
        headers={"Content-Type": ctype, "X-Content-SHA256": sha},
        idempotent=True,
    ) as resp:
        status = resp.status
        raw = resp.read()
    entry = json.loads(raw.decode("utf-8")) if raw else {}
    return status, entry


def cmd_import(args) -> int:
    wiki_dir = os.path.abspath(os.path.expanduser(args.wiki_dir))
    if not os.path.isdir(wiki_dir):
        raise CliError(f"{wiki_dir} is not a folder.", EXIT_USAGE)
    if not 1 <= args.batch_files <= MAX_COMMIT_OPS:
        raise CliError(f"--batch-files must be from 1 to {MAX_COMMIT_OPS}.", EXIT_USAGE)
    if not 1 <= args.batch_bytes <= MAX_COMMIT_BYTES:
        raise CliError(f"--batch-bytes must be from 1 to {MAX_COMMIT_BYTES}.", EXIT_USAGE)
    raw_dir = None
    if args.raw and args.no_raw:
        raise CliError("Use --raw or --no-raw, not both.", EXIT_USAGE)
    if args.raw:
        raw_dir = os.path.abspath(os.path.expanduser(args.raw))
        if not os.path.isdir(raw_dir):
            raise CliError(f"{raw_dir} is not a folder.", EXIT_USAGE)
    elif not args.no_raw and os.path.isdir(os.path.join(wiki_dir, "raw")):
        raw_dir = os.path.join(wiki_dir, "raw")

    client = make_client(args)
    who = client.get("/api/v1/whoami")
    wiki = who.get("wiki") or client.wiki or "main"
    state_path = import_state_path(client.base, wiki, wiki_dir)
    state = load_json_file(state_path) or {}
    state.setdefault("pages", {})
    state.setdefault("raw", {})
    state.update({"url": client.base, "wiki": wiki, "wiki_dir": wiki_dir})

    pages, skipped = scan_pages(wiki_dir, {raw_dir} if raw_dir else set())
    note(f"Found {len(pages)} pages in {wiki_dir}. Skipped {len(skipped)} files.")

    manifest = client.get("/api/v1/manifest")
    remote = manifest.get("pages") or {}
    to_send: list[tuple[LocalPage, dict]] = []
    identical: list[str] = []
    divergent: list[dict] = []
    for page in pages:
        remote_sha = remote.get(page.path)
        # The precondition is the remote state the import saw. A remote edit after
        # this read makes the server refuse the upsert, so the import never hides it.
        if remote_sha == page.sha:
            identical.append(page.path)
        elif remote_sha is None or state["pages"].get(page.path) == remote_sha:
            to_send.append((page, upsert_op(page, remote_sha)))
        else:
            divergent.append({"path": page.path, "local_sha256": page.sha, "remote_sha256": remote_sha})
            if args.overwrite:
                to_send.append((page, upsert_op(page, remote_sha)))
    name = os.path.basename(wiki_dir.rstrip(os.sep)) or wiki_dir
    batches, too_large = make_batches(to_send, args.batch_files, args.batch_bytes, name)
    if too_large:
        large = {p.path for p in too_large}
        skipped.extend({"path": p.path, "reason": "too_large", "bytes": p.size} for p in too_large)
        pages = [p for p in pages if p.path not in large]
    to_upload = sum(len(b) for b in batches)

    raw_files: list[dict] = []
    raw_skipped: list[dict] = []
    raw_remote: dict[str, str] | None = {}
    raw_new: list[dict] = []
    raw_identical: list[str] = []
    raw_conflicts: list[dict] = []
    if raw_dir:
        raw_files, raw_skipped = scan_raw(raw_dir)
        raw_remote = remote_raw_index(client)
        for item in raw_files:
            rsha = (raw_remote or {}).get(item["path"])
            if rsha == item["sha256"]:
                raw_identical.append(item["path"])
            elif rsha is None:
                raw_new.append(item)
            else:
                raw_conflicts.append({"path": item["path"], "local_sha256": item["sha256"], "remote_sha256": rsha})

    report: dict = {
        "wiki_dir": wiki_dir,
        "server": client.base,
        "wiki": wiki,
        "dry_run": bool(args.dry_run),
        "pages": {
            "local": len(pages),
            "remote_before": len(remote),
            "identical": len(identical),
            "to_upload": to_upload,
            "uploaded": 0,
            "batches": len(batches),
            "divergent": divergent,
            "overwrite": bool(args.overwrite),
        },
        "skipped": skipped,
        "raw": {
            "dir": raw_dir,
            "enabled": raw_remote is not None,
            "local": len(raw_files),
            "identical": len(raw_identical),
            "to_upload": len(raw_new),
            "uploaded": 0,
            "conflicts": raw_conflicts,
            "errors": [],
            "skipped": raw_skipped,
        },
        "state_file": state_path,
    }

    if args.dry_run:
        report["plan"] = {
            "batches": [[p.path for p, _ in b] for b in batches],
            "raw_uploads": [r["path"] for r in raw_new] if raw_remote is not None else [],
        }
        if divergent and not args.overwrite:
            report["plan"]["refused"] = "Remote pages differ. Use --overwrite to replace them."
        print_json(report)
        return EXIT_OK

    if divergent and not args.overwrite:
        report["ok"] = False
        report["refused"] = "Remote pages differ from local pages and an earlier import did not write them."
        print_json(report)
        note(f"Stopped: {len(divergent)} remote pages differ. Nothing was written.")
        note("Use --overwrite to replace them, or pull them first.")
        return EXIT_CONFLICT

    upload_mismatches: list[dict] = []
    changed_during_import: list[dict] = []
    report["pages"]["changed_during_import"] = changed_during_import

    def stop(index: int, exc: CliError) -> int:
        atomic_write_json(state_path, state, mode=0o600)
        report["ok"] = False
        report["interrupted"] = {"batch": index, "error": str(exc)}
        print_json(report)
        note(f"Batch {index} of {len(batches)} failed: {exc}")
        note("Run the same command again to continue.")
        return exc.exit_code

    for index, batch in enumerate(batches, 1):
        pending = list(batch)
        while pending:
            body = {"message": import_message(len(pending), name), "ops": [op for _, op in pending]}
            try:
                # Each upsert carries the remote SHA-256 it expects, so a sent-again
                # request cannot replace a newer remote edit.
                result = client.post("/api/v1/commit", body, idempotent=True)
            except ApiFailure as exc:
                reason = exc.details.get("reason") if isinstance(exc.details, dict) else None
                if exc.status != 409 or reason not in ("exists", "sha_mismatch"):
                    return stop(index, exc)
                # A commit is all or nothing. Read the remote state again and sort the pages.
                try:
                    current = client.get("/api/v1/manifest").get("pages") or {}
                except CliError as read_exc:
                    return stop(index, read_exc)
                keep: list[tuple[LocalPage, dict]] = []
                for page, op in pending:
                    rsha = current.get(page.path)
                    if rsha == page.sha:
                        # An earlier request (for example a retry) already wrote this page.
                        state["pages"][page.path] = page.sha
                        report["pages"]["uploaded"] += 1
                    elif rsha == op["expected_sha256"]:
                        keep.append((page, op))
                    else:
                        changed_during_import.append(
                            {"path": page.path, "local_sha256": page.sha, "remote_sha256": rsha}
                        )
                if len(keep) == len(pending):
                    return stop(index, exc)
                pending = keep
                atomic_write_json(state_path, state, mode=0o600)
                continue
            except CliError as exc:
                return stop(index, exc)
            local = {p.path: p.sha for p, _ in pending}
            for ch in result.get("changed") or []:
                path = ch.get("path")
                if path in local:
                    state["pages"][path] = ch.get("sha256")
                    if ch.get("sha256") != local[path]:
                        upload_mismatches.append({"path": path, "local_sha256": local[path], "remote_sha256": ch.get("sha256")})
            atomic_write_json(state_path, state, mode=0o600)
            report["pages"]["uploaded"] += len(pending)
            note(f"Batch {index}/{len(batches)}: {len(pending)} pages (seq {result.get('seq')}).")
            pending = []

    if raw_dir and raw_remote is not None:
        for item in raw_new:
            try:
                with open(item["abs"], "rb") as fh:
                    data = fh.read()
                sha = sha256_bytes(data)
                _, _entry = put_raw(client, item["path"], data, sha)
                item["sha256"] = sha
                state["raw"][item["path"]] = sha
                report["raw"]["uploaded"] += 1
            except ApiFailure as exc:
                if exc.status == 409:
                    report["raw"]["conflicts"].append({"path": item["path"], "local_sha256": item["sha256"], "error": str(exc)})
                else:
                    report["raw"]["errors"].append({"path": item["path"], "error": str(exc)})
            except (CliError, OSError) as exc:
                report["raw"]["errors"].append({"path": item["path"], "error": str(exc)})
        atomic_write_json(state_path, state, mode=0o600)
        note(f"Raw: uploaded {report['raw']['uploaded']} files. {len(raw_identical)} were already on the server.")

    # Verification: every local page and raw file must match the server.
    final = client.get("/api/v1/manifest").get("pages") or {}
    mismatches: list[dict] = []
    for page in pages:
        rsha = final.get(page.path)
        if rsha != page.sha:
            mismatches.append({"kind": "page", "path": page.path, "local_sha256": page.sha, "remote_sha256": rsha})
    raw_checked = 0
    if raw_dir:
        final_raw = remote_raw_index(client)
        if final_raw is None and raw_files:
            report["raw"]["error"] = "The server has no raw storage. Use --no-raw to import pages only."
        for item in raw_files:
            raw_checked += 1
            rsha = (final_raw or {}).get(item["path"])
            if rsha != item["sha256"]:
                mismatches.append({"kind": "raw", "path": item["path"], "local_sha256": item["sha256"], "remote_sha256": rsha})
    report["verification"] = {
        "pages_checked": len(pages),
        "raw_checked": raw_checked,
        "upload_mismatches": upload_mismatches,
        "mismatches": mismatches,
        "seq": None,
    }
    report["ok"] = not mismatches and not upload_mismatches and not report["raw"]["errors"] and not changed_during_import
    print_json(report)
    if changed_during_import:
        note(f"Stopped: {len(changed_during_import)} remote pages changed during the import. They were not replaced.")
        note("Pull them first, or run the import again with --overwrite.")
        return EXIT_CONFLICT
    if not report["ok"]:
        note(f"Verification failed: {len(mismatches)} files do not match the server.")
        return EXIT_FAIL
    note(f"Verification passed: {len(pages)} pages and {raw_checked} raw files match.")
    return EXIT_OK


# ---------------------------------------------------------------------------
# pull
# ---------------------------------------------------------------------------


def _prune_empty_dirs(root: str, path: str) -> None:
    folder = os.path.dirname(path)
    root = os.path.abspath(root)
    while os.path.abspath(folder) != root and folder.startswith(root):
        try:
            os.rmdir(folder)
        except OSError:
            return
        folder = os.path.dirname(folder)


def _git(dir_: str, *cmd: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    # Literal pathspecs: page names such as "a[1].md" are file names, not patterns.
    return subprocess.run(
        ["git", "--literal-pathspecs", "-C", dir_, *cmd], input=stdin, capture_output=True, text=True
    )


def git_commit(dir_: str, paths: list[str], message: str) -> dict:
    """Commit only `paths`. Other staged changes stay staged and out of the commit."""
    probe = _git(dir_, "rev-parse", "--is-inside-work-tree")
    if probe.returncode != 0 or probe.stdout.strip() != "true":
        return {"committed": False, "reason": "not_a_git_repository"}
    spec = "\0".join(paths) + "\0"
    added = _git(dir_, "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul", stdin=spec)
    if added.returncode != 0:
        raise CliError(f"git add failed: {added.stderr.strip()}")
    changed = any(
        _git(dir_, "diff", "--cached", "--quiet", "--", *paths[i : i + 100]).returncode != 0
        for i in range(0, len(paths), 100)
    )
    if not changed:
        return {"committed": False, "reason": "no_changes"}
    done = _git(
        dir_, "commit", "-q", "--only", "-m", message, "--pathspec-from-file=-", "--pathspec-file-nul", stdin=spec
    )
    if done.returncode != 0:
        raise CliError(f"git commit failed: {done.stderr.strip() or done.stdout.strip()}")
    head = _git(dir_, "rev-parse", "HEAD").stdout.strip()
    return {"committed": True, "commit": head}


def cmd_pull(args) -> int:
    target = os.path.abspath(os.path.expanduser(args.dir))
    os.makedirs(target, exist_ok=True)
    client = make_client(args)
    who = client.get("/api/v1/whoami")
    wiki = who.get("wiki") or client.wiki or "main"
    # The state file gets the same symlink check as pages: never read or replace a link.
    state_path = safe_join(target, PULL_STATE_FILE)
    state = load_json_file(state_path)
    if state is None:
        state = {"url": client.base, "wiki": wiki, "seq": 0, "files": {}}
    elif state.get("url") != client.base or state.get("wiki") != wiki:
        raise CliError(
            f"{target} mirrors {state.get('url')} wiki '{state.get('wiki')}'. Use another folder.", EXIT_USAGE
        )
    state.setdefault("files", {})
    # Paths whose write a local file or folder blocked. The cursor moves on, so
    # these are retried from the current page on every later pull.
    pending: set[str] = set(state.get("pending") or [])
    start_seq = int(state.get("seq") or 0)
    since = start_seq
    stamp = utc_stamp()
    written: list[str] = []
    deleted: list[str] = []
    local_copies: list[dict] = []
    warnings: list[str] = []

    def keep_local(path: str, rel: str) -> None:
        # Reserve a new name with O_EXCL so a copy never replaces an older copy.
        n = 0
        while True:
            copy = f"{path}.local-{stamp}" + (f"-{n}" if n else "")
            try:
                fd = os.open(copy, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                n += 1
                continue
            os.close(fd)
            break
        os.replace(path, copy)
        local_copies.append({"path": rel, "saved_as": os.path.relpath(copy, target).replace(os.sep, "/")})

    def local_file_sha(path: str) -> str | None:
        return sha256_file(path) if os.path.isfile(path) else None

    def apply_delete(ch: dict) -> None:
        rel = ch["path"]
        path = safe_join(target, rel)
        if os.path.abspath(path) == os.path.abspath(state_path):
            return
        known = state["files"].get(rel)
        local_sha = local_file_sha(path)
        if local_sha is not None:
            if local_sha != known:
                keep_local(path, rel)
            else:
                os.remove(path)
                _prune_empty_dirs(target, path)
            deleted.append(rel)
        state["files"].pop(rel, None)
        pending.discard(rel)

    def blocked_by_local(rel: str, path: str) -> str | None:
        """Return why local content blocks this write. Removes only an empty folder."""
        if os.path.isdir(path):
            try:
                os.rmdir(path)
            except OSError:
                return f"Skipped {rel}: a local folder with this name holds other files."
        folder = os.path.dirname(path)
        while os.path.abspath(folder) != target:
            if os.path.lexists(folder) and not os.path.isdir(folder):
                where = os.path.relpath(folder, target).replace(os.sep, "/")
                return f"Skipped {rel}: the local file {where} has the name of a folder in this path."
            folder = os.path.dirname(folder)
        return None

    def apply_write(ch: dict) -> None:
        rel = ch["path"]
        path = safe_join(target, rel)
        if os.path.abspath(path) == os.path.abspath(state_path):
            warnings.append(f"Skipped {rel}: the name is reserved for the pull state.")
            return
        known = state["files"].get(rel)
        local_sha = local_file_sha(path)
        new_sha = ch.get("sha256")
        if local_sha is not None and local_sha == new_sha:
            state["files"][rel] = new_sha
            pending.discard(rel)
            return
        problem = blocked_by_local(rel, path)
        if problem:
            warnings.append(problem)
            pending.add(rel)
            return
        content = ch.get("content")
        if content is None:
            content = client.get("/api/v1/page", path=rel).get("content", "")
        data = content.encode("utf-8")
        actual = sha256_bytes(data)
        if new_sha and actual != new_sha:
            warnings.append(f"{rel}: content SHA-256 {actual} does not match {new_sha}.")
        if local_sha is not None and local_sha != known:
            keep_local(path, rel)
        atomic_write_bytes(path, data)
        state["files"][rel] = actual
        pending.discard(rel)
        written.append(rel)

    def save_state() -> None:
        if pending:
            state["pending"] = sorted(pending)
        else:
            state.pop("pending", None)
        atomic_write_json(state_path, state)

    # Retry writes that local content blocked on an earlier pull.
    for rel in sorted(pending):
        try:
            page = client.get("/api/v1/page", path=rel)
        except ApiFailure as e:
            if e.status == 404:
                pending.discard(rel)
                continue
            raise
        apply_write({"path": rel, "sha256": page.get("sha256"), "content": page.get("content", "")})
    save_state()

    while True:
        resp = client.get("/api/v1/changes", since=since, limit=CHANGES_LIMIT)
        changes = resp.get("changes") or []
        # Each path shows only its latest state, so the order inside one page is free.
        # Deletions go first: a move from notes/a.md to notes needs the folder gone.
        for ch in changes:
            if ch.get("deleted"):
                apply_delete(ch)
        for ch in changes:
            if not ch.get("deleted"):
                apply_write(ch)
        next_since = int(resp.get("next_since") or since)
        more = bool(resp.get("more"))
        if more and next_since <= since:
            raise CliError("The server did not move the change cursor forward. Stopped to prevent a loop.")
        state["seq"] = max(next_since, int(resp.get("seq") or 0)) if not more else next_since
        save_state()
        if not more:
            break
        since = next_since

    report: dict = {
        "dir": target,
        "wiki": wiki,
        "from_seq": start_seq,
        "to_seq": state["seq"],
        "written": written,
        "deleted": deleted,
        "local_copies": local_copies,
        "pending": sorted(pending),
        "warnings": warnings,
        "git": None,
    }
    if args.git and (written or deleted):
        message = args.message or f"pull: seq {start_seq} -> {state['seq']} ({len(written)} written, {len(deleted)} deleted)"
        report["git"] = git_commit(target, sorted(set(written + deleted)), message)
        if report["git"].get("reason") == "not_a_git_repository":
            note(f"Warning: {target} is not a git repository. No commit was made.")
    if args.json:
        print_json(report)
    else:
        print(f"Pulled seq {start_seq} -> {state['seq']}: {len(written)} written, {len(deleted)} deleted.")
        for c in local_copies:
            print(f"Local change kept: {c['path']} -> {c['saved_as']}")
        for w in warnings:
            print(f"Warning: {w}")
        if report["git"] and report["git"].get("committed"):
            print(f"Git commit {report['git']['commit'][:12]}.")
    return EXIT_FAIL if warnings else EXIT_OK


# ---------------------------------------------------------------------------
# export, raw
# ---------------------------------------------------------------------------


def _mtime(value) -> float:
    if not value:
        return time.time()
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return time.time()


def cmd_export(args) -> int:
    out = os.path.abspath(os.path.expanduser(args.out))
    client = make_client(args)
    tmp = out + ".part"
    done_seq = None
    pages: dict[str, str] = {}
    bad: list[str] = []
    resp = client.open("GET", "/api/v1/export", headers={"Accept": "application/x-ndjson"})
    try:
        with resp, tarfile.open(tmp, "w:gz") as tar:
            for line in resp:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line.decode("utf-8"))
                if rec.get("done"):
                    done_seq = rec.get("seq")
                    break
                rel = rec["path"]
                check_server_path(rel)
                data = rec.get("content", "").encode("utf-8")
                sha = sha256_bytes(data)
                if rec.get("sha256") and sha != rec["sha256"]:
                    bad.append(rel)
                pages[rel] = sha
                info = tarfile.TarInfo(rel)
                info.size = len(data)
                info.mode = 0o644
                info.mtime = _mtime(rec.get("updated_at"))
                tar.addfile(info, io.BytesIO(data))
            if done_seq is not None:
                meta = json.dumps(
                    {
                        "server": client.base,
                        "seq": done_seq,
                        "exported_at": datetime.now(timezone.utc).isoformat(),
                        "pages": pages,
                    },
                    indent=2,
                    sort_keys=True,
                ).encode("utf-8")
                info = tarfile.TarInfo(EXPORT_MANIFEST)
                info.size = len(meta)
                info.mode = 0o644
                info.mtime = time.time()
                tar.addfile(info, io.BytesIO(meta))
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    if done_seq is None:
        os.unlink(tmp)
        raise CliError("The export stream stopped before the end marker. Run the command again.")
    os.replace(tmp, out)
    report = {"out": out, "pages": len(pages), "seq": done_seq, "sha_mismatches": bad}
    if args.json:
        print_json(report)
    else:
        print(f"Exported {len(pages)} pages at seq {done_seq} to {out}.")
        for b in bad:
            print(f"Warning: SHA-256 does not match for {b}.")
    return EXIT_FAIL if bad else EXIT_OK


def cmd_raw(args) -> int:
    client = make_client(args)
    if args.raw_action == "put":
        src = os.path.expanduser(args.file)
        if not os.path.isfile(src):
            raise CliError(f"{src} is not a file.", EXIT_USAGE)
        rel = args.as_path or os.path.basename(src)
        reason = path_problem(rel)
        if reason:
            raise CliError(f"The raw path '{rel}' is not valid ({reason}).", EXIT_USAGE)
        with open(src, "rb") as fh:
            data = fh.read()
        sha = sha256_bytes(data)
        status, entry = put_raw(client, rel, data, sha, args.content_type)
        if args.json:
            print_json({"status": "created" if status == 201 else "exists", "entry": entry})
        else:
            word = "Uploaded" if status == 201 else "Already present:"
            print(f"{word} raw/{rel} ({len(data)} bytes, sha256 {sha}).")
        return EXIT_OK
    if args.raw_action == "get":
        with client.open("GET", raw_url_path(args.path), headers={"Accept": "*/*"}) as resp:
            data = resp.read()
            expected = resp.headers.get("X-Content-SHA256")
        if expected and sha256_bytes(data) != expected:
            raise CliError(f"The SHA-256 of raw/{args.path} does not match the server value.")
        if args.output and args.output != "-":
            atomic_write_bytes(os.path.abspath(os.path.expanduser(args.output)), data)
            note(f"Wrote {len(data)} bytes to {args.output}.")
        else:
            sys.stdout.flush()
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        return EXIT_OK
    entries = client.get("/api/v1/raw", prefix=args.prefix or "")
    if args.json:
        print_json(entries)
    else:
        for e in entries or []:
            print(f"{e.get('path')}\t{e.get('bytes')}\t{e.get('content_type')}\t{e.get('uploaded_at')}")
    return EXIT_OK


# ---------------------------------------------------------------------------
# search, read, commit, history, lint, graph, review, settings
# ---------------------------------------------------------------------------


def cmd_search(args) -> int:
    client = make_client(args)
    body: dict = {"query": args.query}
    for key in ("top", "type", "tag", "since", "granularity", "per_page"):
        value = getattr(args, key)
        if value is not None:
            body[key] = value
    if args.lexical:
        body["mode"] = "lexical"
    if args.decide:
        body["decide"] = True
    result = client.post("/api/v1/search", body, idempotent=True)
    if args.json:
        print_json(result)
        return EXIT_OK
    rows = result.get("results") or []
    if not rows:
        print("No results.")
    for i, row in enumerate(rows, 1):
        heading = " > ".join(row.get("heading_path") or [])
        where = row.get("rel_path") + (f" # {heading}" if heading else "")
        retr = "+".join(row.get("retrievers") or [])
        print(f"{i}. {where}  ({row.get('score'):.4f}, {retr})")
        snippet = (row.get("snippet") or "").strip().replace("\n", " ")
        if snippet:
            print(f"   {snippet}")
    meta = [f"mode {result.get('mode')}"]
    if result.get("vector_lag"):
        meta.append(f"vector lag {result.get('vector_lag')}")
    dec = result.get("decision")
    if dec:
        meta.append(
            f"decision gate {dec.get('backend')} kept {dec.get('kept')}/{dec.get('pool')}"
            + (" (failed open)" if dec.get("failed_open") else "")
        )
    note("; ".join(meta))
    return EXIT_OK


def cmd_read(args) -> int:
    client = make_client(args)
    body: dict = {"paths": args.paths}
    if args.heading:
        body["heading"] = args.heading
    if args.start_line is not None:
        body["start_line"] = args.start_line
    if args.end_line is not None:
        body["end_line"] = args.end_line
    result = client.post("/api/v1/read", body, idempotent=True)
    missing = result.get("missing") or []
    if args.json:
        print_json(result)
    else:
        pages = result.get("pages") or []
        for page in pages:
            if len(pages) > 1:
                print(f"==> {page.get('path')} (rev {page.get('rev')}) <==")
            content = page.get("content") or ""
            sys.stdout.write(content if content.endswith("\n") or not content else content + "\n")
        for m in missing:
            note(f"Missing: {m}")
    return EXIT_FAIL if missing else EXIT_OK


def cmd_commit(args) -> int:
    if args.ops == "-":
        text = sys.stdin.read()
    else:
        try:
            with open(os.path.expanduser(args.ops), "r", encoding="utf-8") as fh:
                text = fh.read()
        except OSError as exc:
            raise CliError(f"Cannot read {args.ops}: {exc}", EXIT_USAGE)
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise CliError(f"The ops file is not valid JSON: {exc}", EXIT_USAGE)
    if isinstance(data, list):
        body = {"ops": data}
    elif isinstance(data, dict) and isinstance(data.get("ops"), list):
        body = dict(data)
    else:
        raise CliError("The ops file must be a list of ops or an object with an 'ops' list.", EXIT_USAGE)
    if args.message:
        body["message"] = args.message
    if args.log:
        body["log"] = args.log
    if not body.get("message"):
        raise CliError("A commit needs a message. Use --message or put 'message' in the file.", EXIT_USAGE)
    result = make_client(args).post("/api/v1/commit", body)
    if args.json:
        print_json(result)
    else:
        print(f"Commit {result.get('commit_id')} at seq {result.get('seq')}.")
        for ch in result.get("changed") or []:
            state = "deleted" if ch.get("deleted") else f"rev {ch.get('rev')}"
            print(f"  {ch.get('path')} ({state})")
        if result.get("review_flags"):
            print(f"Review flags: {result.get('review_flags')}")
    return EXIT_OK


def cmd_history(args) -> int:
    client = make_client(args)
    if args.revert:
        result = client.post("/api/v1/revert", {"commit_id": args.revert})
        if args.json:
            print_json(result)
        else:
            print(f"Reverted with commit {result.get('commit_id')} at seq {result.get('seq')}.")
        return EXIT_OK
    if args.diff or args.rev is not None:
        if not args.path:
            raise CliError("Give a page path for --diff or --rev.", EXIT_USAGE)
        if args.diff:
            result = client.get("/api/v1/diff", path=args.path, **{"from": args.diff[0], "to": args.diff[1]})
            if args.json:
                print_json(result)
            else:
                sys.stdout.write(result.get("diff") or "")
            return EXIT_OK
        result = client.get("/api/v1/revision", path=args.path, rev=args.rev)
        if args.json:
            print_json(result)
        else:
            sys.stdout.write(result.get("content") or "")
        return EXIT_OK
    result = client.get("/api/v1/history", path=args.path, limit=args.limit, before_seq=args.before_seq)
    if args.json:
        print_json(result)
    else:
        for c in result or []:
            paths = ", ".join(c.get("paths") or [])
            print(f"{c.get('seq')}\t{c.get('created_at')}\t{c.get('author')}\t{c.get('message')}\t[{paths}]")
    return EXIT_OK


def cmd_stats(args) -> int:
    print_json(make_client(args).get("/api/v1/stats"))
    return EXIT_OK


def cmd_lint(args) -> int:
    body: dict = {}
    if args.decide:
        body["decide"] = True
    if args.stale_days is not None:
        body["stale_days"] = args.stale_days
    print_json(make_client(args).post("/api/v1/lint", body, idempotent=True))
    return EXIT_OK


GRAPH_OPS = ("neighbors", "edges", "facts", "path", "export")


def cmd_graph(args) -> int:
    op, rest = args.op, args.args
    req: dict = {"op": op}
    if op in ("neighbors", "facts"):
        if len(rest) != 1:
            raise CliError(f"graph {op} needs one node.", EXIT_USAGE)
        req["node"] = rest[0]
        if op == "neighbors":
            if args.depth is not None:
                req["depth"] = args.depth
            if args.predicate:
                req["predicate"] = args.predicate
    elif op == "edges":
        if rest:
            raise CliError("graph edges takes options only (--node, --predicate, --status, --limit).", EXIT_USAGE)
        for key in ("node", "predicate", "status", "limit"):
            value = getattr(args, key)
            if value is not None:
                req[key] = value
    elif op == "path":
        if len(rest) != 2:
            raise CliError("graph path needs two nodes: FROM TO.", EXIT_USAGE)
        req["from"], req["to"] = rest
        if args.max_depth is not None:
            req["max_depth"] = args.max_depth
    else:
        req["format"] = args.format
    result = make_client(args).post("/api/v1/graph", req, idempotent=True)
    if op == "export" and not args.json and isinstance(result, (str, dict)):
        text = result if isinstance(result, str) else result.get("data") or result.get("content")
        if isinstance(text, str):
            sys.stdout.write(text if text.endswith("\n") else text + "\n")
            return EXIT_OK
    print_json(result)
    return EXIT_OK


def cmd_review(args) -> int:
    client = make_client(args)
    if args.resolve:
        if not args.status:
            raise CliError("Use --status accepted or --status dismissed with --resolve.", EXIT_USAGE)
        path = "/api/v1/review/" + urllib.parse.quote(args.resolve, safe="")
        result = client.post(path, {"status": args.status})
        if args.json:
            print_json(result)
        else:
            print(f"Review flag {args.resolve} is {args.status}.")
        return EXIT_OK
    result = client.get("/api/v1/review", status=None if args.show == "all" else args.show)
    if args.json:
        print_json(result)
    else:
        flags = result or []
        if not flags:
            print("No review flags.")
        for f in flags:
            score = f.get("score")
            score_txt = f" score {score:.2f}" if isinstance(score, (int, float)) else ""
            print(f"{f.get('id')}\t{f.get('status')}\t{f.get('kind')}\t{f.get('path')}{score_txt}\t{f.get('detail')}")
    return EXIT_OK


def parse_setting_value(text: str):
    try:
        return json.loads(text)
    except ValueError:
        return text


def cmd_settings(args) -> int:
    client = make_client(args)
    if not args.set:
        print_json(client.get("/api/v1/settings"))
        return EXIT_OK
    patch: dict = {}
    for item in args.set:
        if "=" not in item:
            raise CliError(f"Use key=value for --set, for example decisions.enabled=true. Got: {item}", EXIT_USAGE)
        key, value = item.split("=", 1)
        parts = [p for p in key.strip().split(".") if p]
        if not parts:
            raise CliError(f"The key is empty in: {item}", EXIT_USAGE)
        node = patch
        for part in parts[:-1]:
            node = node.setdefault(part, {})
            if not isinstance(node, dict):
                raise CliError(f"The key {key} conflicts with another --set value.", EXIT_USAGE)
        node[parts[-1]] = parse_setting_value(value.strip())
    print_json(client.call("PATCH", "/api/v1/settings", body=patch, idempotent=True))
    return EXIT_OK


# ---------------------------------------------------------------------------
# mcp-config
# ---------------------------------------------------------------------------

MCP_CLIENTS = ("claude-code", "codex", "cursor", "gemini", "opencode", "omp", "pi", "generic")


def build_mcp_config(client: str, url: str, name: str, token: str | None, wiki: str | None) -> dict:
    """Return {target, format, snippet, notes} for one MCP client.

    Without a token the snippet references LLM_WIKI_TOKEN in the syntax of the
    client, so the token never shows in the output.
    """
    mcp_url = url.rstrip("/") + "/mcp"
    extra = {"X-LLM-Wiki": wiki} if wiki else {}
    notes: list[str] = []

    def bearer(placeholder: str) -> str:
        return f"Bearer {token}" if token else f"Bearer {placeholder}"

    def json_snippet(obj) -> str:
        return json.dumps(obj, indent=2) + "\n"

    if client == "claude-code":
        parts = ["claude", "mcp", "add", "--transport", "http", name, mcp_url]
        cmd = " ".join(shlex.quote(p) for p in parts)
        if token:
            cmd += " --header " + shlex.quote(f"Authorization: Bearer {token}")
        else:
            cmd += ' --header "Authorization: Bearer ${%s}"' % TOKEN_ENV
            notes.append(f"Set {TOKEN_ENV} in your shell first. The shell puts its value into the Claude Code config.")
        for key, value in extra.items():
            cmd += " --header " + shlex.quote(f"{key}: {value}")
        notes.append("Add --scope user to use the wiki in all projects.")
        return {"target": "claude mcp add (shell command)", "format": "shell", "snippet": cmd + "\n", "notes": notes}

    if client == "codex":
        lines = [f"[mcp_servers.{name}]", f"url = {json.dumps(mcp_url)}"]
        headers = dict(extra)
        if token:
            headers["Authorization"] = f"Bearer {token}"
        else:
            lines.append(f'bearer_token_env_var = "{TOKEN_ENV}"')
            notes.append(f"Set {TOKEN_ENV} in the environment that starts Codex.")
        if headers:
            pairs = ", ".join(f"{json.dumps(k)} = {json.dumps(v)}" for k, v in headers.items())
            lines.append(f"http_headers = {{ {pairs} }}")
        return {"target": "~/.codex/config.toml", "format": "toml", "snippet": "\n".join(lines) + "\n", "notes": notes}

    if client == "cursor":
        server = {"url": mcp_url, "headers": {"Authorization": bearer("${env:%s}" % TOKEN_ENV), **extra}}
        if not token:
            notes.append(f"Set {TOKEN_ENV} in the environment that starts Cursor.")
        return {"target": "~/.cursor/mcp.json or .cursor/mcp.json", "format": "json",
                "snippet": json_snippet({"mcpServers": {name: server}}), "notes": notes}

    if client == "gemini":
        server = {"httpUrl": mcp_url, "headers": {"Authorization": bearer("${%s}" % TOKEN_ENV), **extra}}
        if not token:
            notes.append(f"Set {TOKEN_ENV} in the environment that starts Gemini CLI.")
        return {"target": "~/.gemini/settings.json or .gemini/settings.json", "format": "json",
                "snippet": json_snippet({"mcpServers": {name: server}}), "notes": notes}

    if client == "opencode":
        server = {
            "type": "remote",
            "url": mcp_url,
            "enabled": True,
            "headers": {"Authorization": bearer("{env:%s}" % TOKEN_ENV), **extra},
        }
        if not token:
            notes.append(f"Set {TOKEN_ENV} in the environment that starts OpenCode.")
        return {"target": "opencode.json (project) or ~/.config/opencode/opencode.json", "format": "json",
                "snippet": json_snippet({"$schema": "https://opencode.ai/config.json", "mcp": {name: server}}),
                "notes": notes}

    if client in ("omp", "pi"):
        # Both read {"mcpServers": ...} and expand ${VAR} in headers.
        # Paths: omp docs (mcp-config.md) and https://pi.dev/docs/latest/mcp.
        server = {"type": "http", "url": mcp_url, "headers": {"Authorization": bearer("${%s}" % TOKEN_ENV), **extra}}
        if client == "pi":
            target = "~/.pi/agent/mcp.json (all projects) or .pi/mcp.json (one project)"
            notes.append("Run /reload in a Pi session after you change the file.")
        else:
            target = "~/.omp/agent/mcp.json (all projects) or .omp/mcp.json (one project)"
        if not token:
            notes.append(f"Set {TOKEN_ENV} in the environment that starts the agent.")
        return {"target": target, "format": "json",
                "snippet": json_snippet({"mcpServers": {name: server}}), "notes": notes}

    server = {"type": "http", "url": mcp_url, "headers": {"Authorization": bearer("${%s}" % TOKEN_ENV), **extra}}
    if not token:
        notes.append(f"Replace ${{{TOKEN_ENV}}} with the token if your client does not read environment variables.")
    return {"target": "MCP client config (Streamable HTTP)", "format": "json",
            "snippet": json_snippet({"mcpServers": {name: server}}), "notes": notes}


def cmd_mcp_config(args) -> int:
    if not NAME_RE.match(args.name):
        raise CliError("--name may use only letters, digits, '-' and '_'.", EXIT_USAGE)
    url, token, wiki, _ = resolve_connection(args, need_token=args.show_token)
    out = build_mcp_config(args.client, url, args.name, token if args.show_token else None, wiki)
    if args.json:
        print_json({"client": args.client, **out})
        return EXIT_OK
    note(f"Add this to {out['target']}:")
    for line in out["notes"]:
        note(line)
    sys.stdout.write(out["snippet"])
    return EXIT_OK


# ---------------------------------------------------------------------------
# Argument parser
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    base = argparse.ArgumentParser(add_help=False)
    base.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="Print JSON output.")
    base.add_argument("--profile", default=argparse.SUPPRESS, help="Use this saved profile.")
    base.add_argument("--wiki", default=argparse.SUPPRESS, help="Select this wiki (admin token only).")
    common = argparse.ArgumentParser(add_help=False, parents=[base])
    common.add_argument("--url", dest="url_override", metavar="URL", default=argparse.SUPPRESS, help="Use this server URL.")

    parser = argparse.ArgumentParser(
        prog="wiki_remote.py",
        description="Connect to a hosted LLM Wiki server. Move, mirror, export, and search a wiki.",
        epilog="Exit codes: 0 success, 1 failure, 2 usage error, 3 conflict.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    parser.add_argument("--json", action="store_true", default=False, help="Print JSON output.")
    parser.add_argument("--profile", default=None, help="Use this saved profile.")
    parser.add_argument("--wiki", default=None, help="Select this wiki (admin token only).")
    parser.add_argument("--url", dest="url_override", metavar="URL", default=None, help="Use this server URL.")
    sub = parser.add_subparsers(dest="command", metavar="COMMAND", required=True)

    def add(name: str, help_text: str, func, parents=None, **kw) -> argparse.ArgumentParser:
        p = sub.add_parser(name, help=help_text, description=help_text, parents=parents or [common], **kw)
        p.set_defaults(func=func)
        return p

    p = add("login", "Save a server URL and token. The server checks the token first.", cmd_login, parents=[base])
    p.add_argument("--url", dest="login_url", help="Server URL, for example https://wiki.example.workers.dev.")
    p.add_argument("--token", help="Token. Use '-' to read it from standard input. Without this option, the command asks for it.")

    add("status", "Show the server, the wiki, and your access.", cmd_status)

    p = add("wiki", "Create or list wikis (deployment admin).", cmd_wiki)
    wsub = p.add_subparsers(dest="wiki_action", metavar="ACTION", required=True)
    wc = wsub.add_parser("create", help="Create a wiki.", parents=[common])
    wc.add_argument("id", help="Wiki id: lowercase letters, digits, and '-'.")
    wsub.add_parser("list", help="List the wikis.", parents=[common])

    p = add("token", "Create, list, or revoke agent tokens (admin).", cmd_token)
    tsub = p.add_subparsers(dest="token_action", metavar="ACTION", required=True)
    tc = tsub.add_parser("create", help="Create a token. The server shows it one time.", parents=[common])
    tc.add_argument("--label", required=True, help="Name of the agent that uses the token.")
    tc.add_argument("--scopes", required=True, help="Comma list: read, write, raw:write, admin.")
    tsub.add_parser("list", help="List the tokens.", parents=[common])
    tr = tsub.add_parser("revoke", help="Revoke a token.", parents=[common])
    tr.add_argument("id", help="Token id from the token list.")

    p = add("pair", "Create a one-time pairing code for OAuth sign-in (admin).", cmd_pair)
    p.add_argument("--label", required=True, help="Name of the agent that uses the code.")
    p.add_argument("--scopes", required=True, help="Comma list: read, write, raw:write, admin.")

    p = add(
        "import",
        "Copy a local wiki to the server. The command does not change the local wiki.",
        cmd_import,
        epilog="Run the command again after a failure. It continues from the last good batch.",
    )
    p.add_argument("wiki_dir", help="Local wiki folder.")
    p.add_argument("--raw", help="Raw files folder. Default: <wiki_dir>/raw when it exists.")
    p.add_argument("--no-raw", action="store_true", help="Do not upload raw files.")
    p.add_argument("--dry-run", action="store_true", help="Show the plan. Do not write to the server.")
    p.add_argument("--batch-files", type=int, default=25, help="Maximum pages in one commit (default 25).")
    p.add_argument("--batch-bytes", type=int, default=400_000, help="Maximum bytes in one commit (default 400000).")
    p.add_argument("--overwrite", action="store_true", help="Replace remote pages that differ from the local pages.")

    p = add("pull", "Copy server changes into a local mirror folder.", cmd_pull)
    p.add_argument("dir", help="Mirror folder. The command creates it when it does not exist.")
    p.add_argument("--git", action="store_true", help="Commit the changes when the folder is in a git repository.")
    p.add_argument("--message", help="Git commit message.")

    p = add("export", "Save all pages in a .tar.gz file.", cmd_export)
    p.add_argument("out", help="Output file, for example wiki.tar.gz.")

    p = add("raw", "Upload, download, or list raw files.", cmd_raw)
    rsub = p.add_subparsers(dest="raw_action", metavar="ACTION", required=True)
    rp = rsub.add_parser("put", help="Upload a file. Raw files do not change after upload.", parents=[common])
    rp.add_argument("file", help="Local file.")
    rp.add_argument("--as", dest="as_path", help="Path on the server. Default: the file name.")
    rp.add_argument("--content-type", help="Content type. Default: from the file name.")
    rg = rsub.add_parser("get", help="Download a file.", parents=[common])
    rg.add_argument("path", help="Path on the server.")
    rg.add_argument("-o", "--output", help="Output file. Default: standard output.")
    rl = rsub.add_parser("ls", help="List files.", parents=[common])
    rl.add_argument("prefix", nargs="?", default="", help="Show only paths that start with this text.")

    p = add("search", "Search the wiki.", cmd_search)
    p.add_argument("query", help="Search text.")
    p.add_argument("--top", type=int, help="Number of results.")
    p.add_argument("--type", help="Show only pages of this type.")
    p.add_argument("--tag", help="Show only pages with this tag.")
    p.add_argument("--since", help="Show only pages updated on or after this date (YYYY-MM-DD).")
    p.add_argument("--granularity", choices=("section", "page"), help="Return sections or pages.")
    p.add_argument("--per-page", type=int, help="Maximum sections from one page.")
    p.add_argument("--lexical", action="store_true", help="Use keyword search only.")
    p.add_argument("--decide", action="store_true", help="Filter results with the decision model.")

    p = add("read", "Print one or more pages.", cmd_read)
    p.add_argument("paths", nargs="+", help="Page paths, for example entities/kalman-filter.md.")
    p.add_argument("--heading", help="Print only the section with this heading.")
    p.add_argument("--start-line", type=int, help="First line (1-based).")
    p.add_argument("--end-line", type=int, help="Last line (1-based).")

    p = add("commit", "Send a commit from a JSON file. A conflict gives exit code 3.", cmd_commit)
    p.add_argument("ops", help="JSON file with a commit object or a list of ops. Use '-' for standard input.")
    p.add_argument("--message", help="Commit message.")
    p.add_argument("--log", help="One line to add to log.md in the same commit.")

    p = add("history", "Show commits, a diff, or an old revision. Revert a commit.", cmd_history)
    p.add_argument("path", nargs="?", help="Show only commits for this page.")
    p.add_argument("--limit", type=int, help="Maximum number of commits.")
    p.add_argument("--before-seq", type=int, help="Show commits before this seq.")
    p.add_argument("--diff", nargs=2, type=int, metavar=("FROM", "TO"), help="Show the diff between two revisions of the page.")
    p.add_argument("--rev", type=int, help="Print this revision of the page.")
    p.add_argument("--revert", metavar="COMMIT_ID", help="Revert this commit with a new commit.")

    p = add("lint", "Check the wiki for structure and graph problems.", cmd_lint)
    p.add_argument("--decide", action="store_true", help="Check graph evidence with the decision model.")
    p.add_argument("--stale-days", type=int, help="Report pages older than this number of days.")

    add("stats", "Show wiki size, page types, and link density.", cmd_stats)

    p = add(
        "graph",
        "Query the knowledge graph.",
        cmd_graph,
        epilog="Ops: neighbors NODE, edges, facts NODE, path FROM TO, export.",
    )
    p.add_argument("op", choices=GRAPH_OPS, help="Graph operation.")
    p.add_argument("args", nargs="*", help="Nodes for the operation.")
    p.add_argument("--depth", type=int, help="Depth for neighbors.")
    p.add_argument("--predicate", help="Show only edges with this predicate.")
    p.add_argument("--node", help="Show only edges of this node (edges).")
    p.add_argument("--status", help="Show only edges with this status (edges).")
    p.add_argument("--limit", type=int, help="Maximum number of edges.")
    p.add_argument("--max-depth", type=int, help="Maximum path length (path).")
    p.add_argument("--format", choices=("jsonl", "graphml"), default="jsonl", help="Export format.")

    p = add("review", "List or resolve review flags.", cmd_review)
    p.add_argument("--resolve", metavar="ID", help="Resolve this review flag.")
    p.add_argument("--status", choices=("accepted", "dismissed"), help="New status for --resolve.")
    p.add_argument("--show", choices=("open", "accepted", "dismissed", "all"), default="open", help="Flags to list (default open).")

    p = add("settings", "Show or change wiki settings.", cmd_settings)
    p.add_argument("--set", action="append", metavar="KEY=VALUE", help="Change one setting, for example decisions.enabled=true. Use again for more.")

    p = add("mcp-config", "Print MCP configuration for an agent client. The token stays hidden.", cmd_mcp_config)
    p.add_argument("client", choices=MCP_CLIENTS, help="Agent client.")
    p.add_argument("--name", default="llm-wiki", help="Server name in the client config (default llm-wiki).")
    p.add_argument("--show-token", action="store_true", help="Put the token in the output. Do not share the output.")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args) or EXIT_OK)
    except ApiFailure as exc:
        if exc.status == 409:
            note(f"Conflict: {exc}")
            print_json({"error": {"code": exc.code, "message": str(exc), "details": exc.details}})
        else:
            note(f"Error: HTTP {exc.status} {exc.code}: {exc}")
            if exc.details is not None:
                note(json.dumps(exc.details, ensure_ascii=False))
        return exc.exit_code
    except CliError as exc:
        note(f"Error: {exc}")
        return exc.exit_code
    except KeyboardInterrupt:
        note("Stopped.")
        return EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())
