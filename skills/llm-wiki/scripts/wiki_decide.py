#!/usr/bin/env python3
"""
wiki_decide.py: optional typed-decision checks for an LLM Wiki (stdlib only).

A decision model reads a state and answers typed questions with a choice and
probabilities. It never writes text. This tool is off by default. It sends
wiki text to a backend only when you select that backend with --backend or
the LLM_WIKI_DECISIONS environment variable.

Backends:
    local       llama-server with LiquidAI/d1-2B-GGUF (default http://127.0.0.1:8080). No key.
    typesafe    TypeSafe Jev (https://api.typesafe.ai). Needs TYPESAFE_API_KEY.
    openrouter  Jev through OpenRouter (https://openrouter.ai/api). Needs OPENROUTER_API_KEY.
    liquid      Liquid decisions API (https://api.liquid.ai/decisions). Needs LIQUID_API_KEY.
    hosted      Your hosted wiki server (/api/v1/decide). Uses LLM_WIKI_URL and LLM_WIKI_TOKEN
                or the wiki_remote.py profile.

Environment:
    LLM_WIKI_DECISIONS          Backend name (default: off).
    LLM_WIKI_DECISIONS_URL      Backend base URL.
    LLM_WIKI_DECISIONS_MODEL    Model name.

Commands:
    ask [FILE]                     Send a raw {state, questions} JSON request (FILE or stdin).
    screen FILE                    Check if text gives orders to an AI system (D5).
    shortlist SOURCE [--wiki DIR]  Rank wiki pages that a new source changes (D4).
    contradictions [--wiki DIR]    Find section pairs that contradict (D3).
    check                          Test the backend connection.

On a backend error the checks fail open: the output keeps the unchecked
result, sets "failed_open": true, and a note goes to stderr.

Examples:
    LLM_WIKI_DECISIONS=local python wiki_decide.py check
    python wiki_decide.py --backend openrouter screen raw/article.md
    python wiki_decide.py --backend local shortlist raw/paper.md --wiki wiki
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import shutil
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable

SCRIPT_DIR = Path(__file__).resolve().parent
QUESTIONS_PATH = SCRIPT_DIR.parent / "assets" / "decision-questions.json"

BACKENDS = {
    "local": {"url": "http://127.0.0.1:8080", "model": "d1-2B", "key": None},
    "typesafe": {"url": "https://api.typesafe.ai", "model": "jev-1.14.0", "key": "TYPESAFE_API_KEY"},
    "openrouter": {"url": "https://openrouter.ai/api", "model": "typesafe/jev-1.14", "key": "OPENROUTER_API_KEY"},
    "liquid": {"url": "https://api.liquid.ai/decisions", "model": "d1.1", "key": "LIQUID_API_KEY"},
    "hosted": {"url": None, "model": "server", "key": None},
}
BACKEND_CHOICES = ("off", *BACKENDS)
DEFAULT_TIMEOUT = 8.0
MAX_WORKERS = 8
REMOTE_CONFIG = Path("~/.config/llm-wiki/remote.json")


def load_questions() -> dict:
    return json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))["checks"]


QUESTIONS = load_questions()


class DecisionError(Exception):
    """A backend call failed. `code` is one of: unavailable, insufficient_credits,
    timeout, http, invalid_answer, bad_request."""

    def __init__(self, code: str, message: str, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status


Transport = Callable[[dict], dict]


class DecisionClient:
    """Posts System One requests to one backend. `transport` replaces HTTP in tests."""

    def __init__(
        self,
        backend: str,
        url: str,
        model: str,
        key: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        transport: Transport | None = None,
    ):
        self.backend = backend
        self.url = url
        self.model = model
        self.key = key
        self.timeout = timeout
        self.transport = transport

    @property
    def endpoint(self) -> str:
        base = self.url.rstrip("/")
        if self.backend == "hosted":
            return base if base.endswith("/api/v1/decide") else base + "/api/v1/decide"
        return base if base.endswith("/v1/systemone") else base + "/v1/systemone"

    def ask(self, request: dict) -> dict:
        """Return {"answers", "model", "latency_ms"}. Raises DecisionError."""
        if not isinstance(request, dict) or "state" not in request or not isinstance(request.get("questions"), dict):
            raise DecisionError("bad_request", "request needs state and questions")
        started = time.monotonic()
        if self.transport is not None:
            raw = self.transport({"model": self.model, **request})
        else:
            raw = self._post(request)
        payload = raw.get("result") if isinstance(raw, dict) and not isinstance(raw.get("answers"), dict) and isinstance(raw.get("result"), dict) else raw
        if not isinstance(payload, dict) or not isinstance(payload.get("answers"), dict):
            raise DecisionError("invalid_answer", "backend response has no answers object")
        return {
            "answers": payload["answers"],
            "model": payload.get("model") if isinstance(payload.get("model"), str) else self.model,
            "latency_ms": int((time.monotonic() - started) * 1000),
        }

    def _post(self, request: dict) -> dict:
        body = {"state": request["state"], "questions": request["questions"]}
        if self.backend != "hosted":
            body = {"model": self.model, **body}
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.key:
            headers["Authorization"] = f"Bearer {self.key}"
        req = urllib.request.Request(self.endpoint, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                text = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
            code = "insufficient_credits" if exc.code == 402 or "insufficient" in detail.lower() and "credit" in detail.lower() else "http"
            raise DecisionError(code, f"HTTP {exc.code}: {detail}", exc.code) from None
        except (TimeoutError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            if isinstance(reason, TimeoutError) or "timed out" in str(reason).lower():
                raise DecisionError("timeout", f"no answer after {self.timeout} s") from None
            raise DecisionError("unavailable", f"cannot reach {self.endpoint}: {reason}") from None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            raise DecisionError("invalid_answer", "backend response is not JSON") from None


def note(message: str) -> None:
    print(f"decisions: {message}", file=sys.stderr)


def read_remote_profile(profile: str | None) -> tuple[str | None, str | None]:
    url = os.environ.get("LLM_WIKI_URL")
    token = os.environ.get("LLM_WIKI_TOKEN")
    if url and token:
        return url, token
    path = REMOTE_CONFIG.expanduser()
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return url, token
    name = profile or config.get("default")
    entry = (config.get("profiles") or {}).get(name) or {}
    return url or entry.get("url"), token or entry.get("token")


def client_from_config(
    backend: str | None = None,
    url: str | None = None,
    model: str | None = None,
    timeout: float | None = None,
    profile: str | None = None,
) -> DecisionClient | None:
    """Build a client from flags, then environment. Returns None when decisions are off.
    Raises DecisionError("unavailable") when the selected backend lacks a key or URL."""
    name = (backend or os.environ.get("LLM_WIKI_DECISIONS") or "off").strip().lower()
    if name in ("", "off", "none", "0", "false"):
        return None
    if name not in BACKENDS:
        raise DecisionError("bad_request", f"unknown backend {name!r}; use one of {', '.join(BACKEND_CHOICES)}")
    spec = BACKENDS[name]
    url = url or os.environ.get("LLM_WIKI_DECISIONS_URL") or spec["url"]
    model = model or os.environ.get("LLM_WIKI_DECISIONS_MODEL") or spec["model"]
    key = os.environ.get(spec["key"]) if spec["key"] else None
    if spec["key"] and not key:
        raise DecisionError("unavailable", f"set {spec['key']} to use the {name} backend")
    if name == "hosted":
        remote_url, token = read_remote_profile(profile)
        url = url or remote_url
        key = token
        if not url or not token:
            raise DecisionError("unavailable", "set LLM_WIKI_URL and LLM_WIKI_TOKEN, or run wiki_remote.py login")
    return DecisionClient(name, url, model, key, timeout or DEFAULT_TIMEOUT)


# ---------------------------------------------------------------------------
# Answer reading
# ---------------------------------------------------------------------------

def read_choice(answers: dict, name: str, keys: list[str]) -> dict:
    """Validate a choice answer against the sent keys. Probabilities are renormalized
    over `keys`. Raises DecisionError("invalid_answer")."""
    answer = answers.get(name) if isinstance(answers, dict) else None
    if not isinstance(answer, dict):
        raise DecisionError("invalid_answer", f"no answer for {name}")
    choice = answer.get("choice")
    if not isinstance(choice, str) or choice not in keys:
        raise DecisionError("invalid_answer", f"answer for {name} has an unknown choice {choice!r}")
    probs = {}
    raw_probs = answer.get("probabilities")
    if isinstance(raw_probs, dict):
        for k in keys:
            p = raw_probs.get(k)
            if isinstance(p, (int, float)) and not isinstance(p, bool) and p >= 0:
                probs[k] = float(p)
        total = sum(probs.values())
        if total > 0:
            probs = {k: v / total for k, v in probs.items()}
    confidence = answer.get("confidence")
    confidence = float(confidence) if isinstance(confidence, (int, float)) and not isinstance(confidence, bool) else None
    if not probs:
        if confidence is None:
            raise DecisionError("invalid_answer", f"answer for {name} has no probabilities")
        probs[choice] = confidence
        if len(keys) == 2:
            probs[next(k for k in keys if k != choice)] = 1 - confidence
    if confidence is None:
        confidence = probs.get(choice, 0.0)
    return {"choice": choice, "confidence": confidence, "probabilities": probs}


def choice_question(check: str) -> dict:
    t = QUESTIONS[check]
    return {t["question"]: {"type": t["type"], "instructions": t["instructions"], "criteria": t["criteria"]}}


def positive_probability(answers: dict, check: str) -> float:
    t = QUESTIONS[check]
    ans = read_choice(answers, t["question"], list(t["criteria"]))
    return ans["probabilities"].get(t["positive"], 0.0)


def ask_many(client: DecisionClient, requests: list[dict]) -> list[dict]:
    """Run requests in parallel threads. Raises the first DecisionError."""
    if not requests:
        return []
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(requests))) as pool:
        return list(pool.map(client.ask, requests))


def block(client: DecisionClient | None, threshold: float, started: float, **extra) -> dict:
    return {
        "backend": client.backend if client else "off",
        "model": client.model if client else None,
        "threshold": threshold,
        "latency_ms": int((time.monotonic() - started) * 1000),
        **extra,
    }


# ---------------------------------------------------------------------------
# D1 relevance gate
# ---------------------------------------------------------------------------

def relevance_request(query: str, title: str, heading: str, text: str) -> dict:
    t = QUESTIONS["relevance"]
    return {
        "state": {"query": query, "title": title, "heading": heading, "text": text[: t["max_text_chars"]]},
        "questions": choice_question("relevance"),
    }


def score_relevance(client: DecisionClient, query: str, rows: list[dict], texts: list[str]) -> list[float]:
    """P(relevant) for each row. `rows` carry `title` and `heading_path`. Raises DecisionError."""
    requests = [
        relevance_request(query, row.get("title") or "", " > ".join(row.get("heading_path") or []), text)
        for row, text in zip(rows, texts)
    ]
    return [positive_probability(r["answers"], "relevance") for r in ask_many(client, requests)]


def gate_pool(
    client: DecisionClient | None,
    query: str,
    rows: list[dict],
    texts: list[str],
    threshold: float,
    top: int,
) -> tuple[list[int], dict[int, dict], dict]:
    """Return (kept pool indices in order, capped at `top`; per-index row decision; decision block).
    Keeps rows with P(relevant) >= threshold. Fails open: the first `top` indices, failed_open true."""
    started = time.monotonic()
    try:
        if client is None:
            raise DecisionError("unavailable", "no backend configured (set LLM_WIKI_DECISIONS)")
        scores = score_relevance(client, query, rows, texts)
    except DecisionError as exc:
        note(f"relevance gate failed open ({exc.code}: {exc})")
        kept = list(range(min(top, len(rows))))
        return kept, {}, block(client, threshold, started, pool=len(rows), kept=len(kept), dropped=0,
                               failed_open=True, error=exc.code)
    passed = [i for i, score in enumerate(scores) if score >= threshold]
    row_decisions = {
        i: {"relevant": round(scores[i], 4), "backend": client.backend, "model": client.model} for i in passed
    }
    return passed[:top], row_decisions, block(client, threshold, started, pool=len(rows), kept=len(passed),
                                              dropped=len(rows) - len(passed), failed_open=False)


# ---------------------------------------------------------------------------
# D2 evidence check
# ---------------------------------------------------------------------------

FENCE_RE = re.compile(r"^\s*(```|~~~)")
BLOCK_PREFIX_RE = re.compile(r"^(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)")
SENTENCE_END_RE = re.compile(r"(?<=[.!?])\s+")


def normalize_for_match(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


def evidence_in_text(evidence: str, body: str) -> bool:
    """True when `evidence` occurs in `body`, ignoring case and whitespace."""
    needle = normalize_for_match(evidence or "")
    return bool(needle) and needle in normalize_for_match(body)


def split_sentences(text: str, max_sentences: int = 60, max_chars: int = 300) -> list[str]:
    """Split Markdown into sentences. Mirrors splitSentences in server/src/decisions."""
    blocks: list[str] = []
    para: list[str] = []
    in_fence = False

    def flush() -> None:
        if para:
            blocks.append(" ".join(para))
        para.clear()

    for raw_line in text.split("\n"):
        if FENCE_RE.match(raw_line):
            flush()
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        line = raw_line.strip()
        if not line or line == "---":
            flush()
            continue
        if BLOCK_PREFIX_RE.match(line):
            flush()
            blocks.append(BLOCK_PREFIX_RE.sub("", line, count=1))
            continue
        para.append(line)
    flush()
    out: list[str] = []
    for blk in blocks:
        for piece in SENTENCE_END_RE.split(blk):
            s = re.sub(r"\s+", " ", piece).strip()
            if not s:
                continue
            out.append(s[:max_chars])
            if len(out) >= max_sentences:
                return out
    return out


def evidence_request(claim: str, evidence: str, sentences: list[str]) -> dict:
    t = QUESTIONS["evidence"]
    criteria = {f"{t['sentence_key_prefix']}{i + 1}": s for i, s in enumerate(sentences)}
    criteria[t["none_key"]] = t["none_criterion"]
    return {
        "state": {"claim": claim, "evidence": evidence},
        "questions": {t["question"]: {"type": t["type"], "instructions": t["instructions"], "criteria": criteria}},
    }


def check_evidence(client: DecisionClient, claim: str, evidence: str, body: str, threshold: float) -> dict:
    """D2 verdict for one edge. Raises DecisionError on backend failure."""
    t = QUESTIONS["evidence"]
    if evidence_in_text(evidence, body):
        return {"supported": True, "choice": "quote", "confidence": 1.0, "sentence": None}
    sentences = split_sentences(body, t["max_sentences"], t["max_sentence_chars"])
    if not sentences:
        return {"supported": False, "choice": t["none_key"], "confidence": 1.0, "sentence": None}
    res = client.ask(evidence_request(claim, evidence, sentences))
    keys = [f"{t['sentence_key_prefix']}{i + 1}" for i in range(len(sentences))] + [t["none_key"]]
    ans = read_choice(res["answers"], t["question"], keys)
    idx = -1 if ans["choice"] == t["none_key"] else int(ans["choice"][len(t["sentence_key_prefix"]):]) - 1
    return {
        "supported": ans["choice"] != t["none_key"] and ans["confidence"] >= threshold,
        "choice": ans["choice"],
        "confidence": round(ans["confidence"], 4),
        "sentence": sentences[idx] if idx >= 0 else None,
    }


# ---------------------------------------------------------------------------
# D3 relation, D4 changes, D5 screen
# ---------------------------------------------------------------------------

def relation_request(entity: str, a: dict, b: dict) -> dict:
    limit = QUESTIONS["relation"]["max_text_chars"]
    return {
        "state": {
            "entity": entity,
            "passage_a": {"page": a["title"], "text": a["text"][:limit]},
            "passage_b": {"page": b["title"], "text": b["text"][:limit]},
        },
        "questions": choice_question("relation"),
    }


def changes_request(source_title: str, source_text: str, page_title: str, page_text: str) -> dict:
    t = QUESTIONS["changes"]
    return {
        "state": {
            "source": {"title": source_title, "text": source_text[: t["max_source_chars"]]},
            "page": {"title": page_title, "text": page_text[: t["max_text_chars"]]},
        },
        "questions": choice_question("changes"),
    }


def screen_request(path: str, text: str) -> dict:
    return {
        "state": {"path": path, "text": text[: QUESTIONS["orders_agent"]["max_text_chars"]]},
        "questions": choice_question("orders_agent"),
    }


def screen_text(client: DecisionClient | None, path: str, text: str, threshold: float) -> dict:
    started = time.monotonic()
    try:
        if client is None:
            raise DecisionError("unavailable", "no backend configured (set LLM_WIKI_DECISIONS)")
        res = client.ask(screen_request(path, text))
        score = positive_probability(res["answers"], "orders_agent")
    except DecisionError as exc:
        note(f"screen failed open ({exc.code}: {exc})")
        return {"path": path, "score": None, "flagged": False,
                **block(client, threshold, started, failed_open=True, error=exc.code)}
    return {"path": path, "score": round(score, 4), "flagged": score >= threshold,
            **block(client, threshold, started, failed_open=False)}


# ---------------------------------------------------------------------------
# Wiki helpers (reuse the search parser)
# ---------------------------------------------------------------------------

def load_search_module():
    sys.path.insert(0, str(SCRIPT_DIR))
    import wiki_search  # noqa: E402

    return wiki_search


def strip_frontmatter(text: str) -> tuple[str, str]:
    """Return (title, body) of a Markdown file."""
    ws = load_search_module()
    meta, body = ws.parse_frontmatter(text)
    title = meta.get("title") if isinstance(meta, dict) else None
    if not title:
        m = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
        title = m.group(1).strip() if m else ""
    return title or "", body


def search_candidates(source_query: str, wiki: Path, top: int, no_embed: bool) -> list[dict]:
    script = SCRIPT_DIR / "wiki_search.py"
    argv = [source_query, "--wiki", str(wiki), "--json", "--top", str(top), "--per-page", "1"]
    if no_embed:
        argv.append("--no-embed")
    uv = shutil.which("uv")
    cmd = [uv, "run", "--quiet", "--script", str(script), *argv] if uv and not no_embed else [sys.executable, str(script), *argv]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not proc.stdout.strip():
        return []
    return json.loads(proc.stdout).get("results", [])


def cmd_shortlist(args, client: DecisionClient | None) -> int:
    source_path = Path(args.source)
    text = source_path.read_text(encoding="utf-8")
    title, body = strip_frontmatter(text)
    title = title or source_path.stem
    t = QUESTIONS["changes"]
    query = f"{title} {body[: t['max_source_chars']]}"
    rows = search_candidates(query, args.wiki, args.top, args.no_embed)
    threshold = args.threshold if args.threshold is not None else t["default_threshold"]
    started = time.monotonic()
    candidates = []
    for rank, row in enumerate(rows, 1):
        page_file = args.wiki / row["rel_path"]
        try:
            _, page_body = strip_frontmatter(page_file.read_text(encoding="utf-8"))
        except OSError:
            page_body = row.get("snippet", "")
        candidates.append({"rel_path": row["rel_path"], "title": row["title"], "search_rank": rank, "text": page_body})
    try:
        if client is None:
            raise DecisionError("unavailable", "no backend configured (set LLM_WIKI_DECISIONS)")
        results = ask_many(client, [changes_request(title, body, c["title"], c["text"]) for c in candidates])
        scores = [positive_probability(r["answers"], "changes") for r in results]
    except DecisionError as exc:
        note(f"shortlist failed open ({exc.code}: {exc}); pages keep search order")
        out = [{k: v for k, v in c.items() if k != "text"} | {"changes": None} for c in candidates]
        print(json.dumps({"source": str(source_path), "candidates": out,
                          "decision": block(client, threshold, started, failed_open=True, error=exc.code)}, indent=2))
        return 0
    ranked = sorted(
        ({k: v for k, v in c.items() if k != "text"} | {"changes": round(s, 4), "shortlisted": s >= threshold}
         for c, s in zip(candidates, scores)),
        key=lambda c: (-c["changes"], c["search_rank"]),
    )
    print(json.dumps({"source": str(source_path), "candidates": ranked,
                      "decision": block(client, threshold, started, failed_open=False,
                                        shortlisted=sum(1 for c in ranked if c["shortlisted"]))}, indent=2))
    return 0


def contradiction_pairs(wiki: Path, max_pairs: int) -> list[tuple[str, dict, dict]]:
    """Pairs of sections from different pages that link the same entity page."""
    ws = load_search_module()
    pages = ws.collect_pages(wiki)
    by_path, by_slug = ws.build_link_index(pages)
    entity_titles = {p["slug"]: p["meta"].get("title") or p["slug"] for p in pages if p["meta"].get("type") == "entity"}
    mentions: dict[str, list[dict]] = {}
    for page in pages:
        title = page["meta"].get("title") or page["slug"]
        for section in page["sections"]:
            linked = set()
            for m in ws.WIKILINK_RE.finditer(section["text"]):
                slug = ws.resolve_link(m.group(1), by_path, by_slug)
                if slug in entity_titles and slug != page["slug"]:
                    linked.add(slug)
            text = section["text"].strip()
            if not text:
                continue
            for slug in sorted(linked):
                mentions.setdefault(slug, []).append({
                    "rel_path": page["rel_path"],
                    "title": title,
                    "heading": " > ".join(section["heading_path"]),
                    "text": text,
                })
    pairs = []
    for slug in sorted(mentions):
        items = mentions[slug]
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                if items[i]["rel_path"] == items[j]["rel_path"]:
                    continue
                pairs.append((entity_titles[slug], items[i], items[j]))
                if len(pairs) >= max_pairs:
                    return pairs
    return pairs


def cmd_contradictions(args, client: DecisionClient | None) -> int:
    t = QUESTIONS["relation"]
    threshold = args.threshold if args.threshold is not None else t["default_threshold"]
    pairs = contradiction_pairs(args.wiki, args.max_pairs)
    started = time.monotonic()
    try:
        if client is None:
            raise DecisionError("unavailable", "no backend configured (set LLM_WIKI_DECISIONS)")
        results = ask_many(client, [relation_request(e, a, b) for e, a, b in pairs])
        answers = [read_choice(r["answers"], t["question"], list(t["criteria"])) for r in results]
    except DecisionError as exc:
        note(f"contradiction screen failed open ({exc.code}: {exc}); no pairs checked")
        print(json.dumps({"pairs": len(pairs), "flagged": [],
                          "decision": block(client, threshold, started, failed_open=True, error=exc.code)}, indent=2))
        return 0
    flagged = []
    for (entity, a, b), ans in zip(pairs, answers):
        p = ans["probabilities"].get(t["positive"], 0.0)
        if p >= threshold:
            flagged.append({
                "entity": entity,
                "a": {"rel_path": a["rel_path"], "heading": a["heading"]},
                "b": {"rel_path": b["rel_path"], "heading": b["heading"]},
                "contradicts": round(p, 4),
                "choice": ans["choice"],
            })
    flagged.sort(key=lambda f: -f["contradicts"])
    print(json.dumps({"pairs": len(pairs), "flagged": flagged,
                      "decision": block(client, threshold, started, failed_open=False)}, indent=2))
    return 0


def cmd_screen(args, client: DecisionClient | None) -> int:
    text = Path(args.file).read_text(encoding="utf-8", errors="replace")
    threshold = args.threshold if args.threshold is not None else QUESTIONS["orders_agent"]["default_threshold"]
    print(json.dumps(screen_text(client, str(args.file), text, threshold), indent=2))
    return 0


def cmd_ask(args, client: DecisionClient | None) -> int:
    raw = sys.stdin.read() if args.file in (None, "-") else Path(args.file).read_text(encoding="utf-8")
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        note(f"request is not JSON ({exc})")
        return 2
    if client is None:
        note("no backend configured (set LLM_WIKI_DECISIONS or --backend)")
        return 1
    try:
        res = client.ask(request)
    except DecisionError as exc:
        note(f"{client.backend} failed ({exc.code}: {exc})")
        return 1
    print(json.dumps({**res, "backend": client.backend}, indent=2))
    return 0


def cmd_check(args, client: DecisionClient | None) -> int:
    if client is None:
        print(json.dumps({"ok": False, "backend": "off", "error": "no backend configured"}))
        return 1
    started = time.monotonic()
    try:
        res = client.ask(relevance_request("what is a wiki", "Wiki", "Overview", "A wiki is a set of linked pages that people edit."))
        positive_probability(res["answers"], "relevance")
    except DecisionError as exc:
        print(json.dumps({"ok": False, "backend": client.backend, "model": client.model,
                          "url": client.endpoint, "error": exc.code, "message": str(exc)}))
        return 1
    print(json.dumps({"ok": True, "backend": client.backend, "model": client.model, "url": client.endpoint,
                      "latency_ms": int((time.monotonic() - started) * 1000)}))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--backend", choices=BACKEND_CHOICES, help="Decision backend (default: LLM_WIKI_DECISIONS or off).")
    parser.add_argument("--model", help="Model name (default: LLM_WIKI_DECISIONS_MODEL or the backend default).")
    parser.add_argument("--url", help="Backend base URL (default: LLM_WIKI_DECISIONS_URL or the backend default).")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="Request timeout in seconds (default: 8).")
    parser.add_argument("--profile", help="wiki_remote.py profile for the hosted backend.")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("ask", help="Send a raw {state, questions} request.")
    p.add_argument("file", nargs="?", help="Request JSON file (default: stdin).")

    p = sub.add_parser("screen", help="Check if text gives orders to an AI system (D5).")
    p.add_argument("file")
    p.add_argument("--threshold", type=float, help="Flag at or above this probability (default: 0.7).")

    p = sub.add_parser("shortlist", help="Rank wiki pages that a new source changes (D4).")
    p.add_argument("source")
    p.add_argument("--wiki", type=Path, default=Path("wiki"))
    p.add_argument("--top", type=int, default=QUESTIONS["changes"]["pool"], help="Search candidates (default: 30).")
    p.add_argument("--threshold", type=float, help="Shortlist at or above this probability (default: 0.5).")
    p.add_argument("--no-embed", action="store_true", help="Use lexical search for candidates.")

    p = sub.add_parser("contradictions", help="Find section pairs that contradict (D3).")
    p.add_argument("--wiki", type=Path, default=Path("wiki"))
    p.add_argument("--max-pairs", type=int, default=40, help="Most pairs to check (default: 40).")
    p.add_argument("--threshold", type=float, help="Report at or above this probability (default: 0.5).")

    sub.add_parser("check", help="Test the backend connection.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        client = client_from_config(args.backend, args.url, args.model, args.timeout, args.profile)
    except DecisionError as exc:
        note(str(exc))
        if args.command in ("ask", "check"):
            return 1
        client = None
    if args.command in ("shortlist", "contradictions") and not args.wiki.exists():
        print(f"Wiki directory not found: {args.wiki}", file=sys.stderr)
        return 1
    handlers = {
        "ask": cmd_ask,
        "screen": cmd_screen,
        "shortlist": cmd_shortlist,
        "contradictions": cmd_contradictions,
        "check": cmd_check,
    }
    return handlers[args.command](args, client)


if __name__ == "__main__":
    sys.exit(main())
