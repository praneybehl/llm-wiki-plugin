#!/usr/bin/env python3
"""Deterministic fake System One backend for offline decision tests and the eval smoke run.

`answer(request)` scores questions with token overlap heuristics. `serve(handler)`
starts a local HTTP server on 127.0.0.1 that speaks `/v1/systemone` and
`/api/v1/decide`. The fake never calls the network.
"""

from __future__ import annotations

import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

FAKE_MODEL = "fake-overlap-1"
STOP = {
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "did", "for", "from", "how",
    "i", "in", "is", "it", "its", "of", "on", "or", "that", "the", "this", "to", "use", "used", "uses",
    "what", "when", "which", "who", "why", "with", "into", "so", "than", "over", "per", "model",
}
NEGATION = re.compile(r"\b(not|never|no|cannot|only)\b", re.I)
NUMBER = re.compile(r"\d+(?:\.\d+)?(?:e-?\d+)?")
ORDER_MARKERS = re.compile(
    r"ignore (all )?previous instructions|\byou are now\b|\b(ai|assistant|chatbot|language model|llm|agent)s?\b[^.\n]{0,40}"
    r"\b(must|please|should|reading this|instruction|:)|system override|disregard|hidden (text|prompt)|developer mode",
    re.I,
)


def tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in STOP}


def overlap(needle: str, haystack: str) -> float:
    q = tokens(needle)
    return len(q & tokens(haystack)) / len(q) if q else 0.0


def choice_answer(probabilities: dict[str, float]) -> dict:
    total = sum(probabilities.values()) or 1.0
    probs = {k: v / total for k, v in probabilities.items()}
    best = max(probs, key=lambda k: probs[k])
    return {"type": "choice", "choice": best, "confidence": probs[best], "probabilities": probs}


def text_of(value) -> str:
    return value if isinstance(value, str) else json.dumps(value)


def answer_question(name: str, question: dict, state) -> dict:
    keys = list((question.get("criteria") or {}).keys())
    st = state if isinstance(state, dict) else {"text": text_of(state)}
    if name == "relevant":
        p = min(1.0, overlap(st.get("query", ""), f"{st.get('title', '')} {st.get('heading', '')} {st.get('text', '')}") * 1.2)
        return choice_answer({"A": p + 0.01, "B": 1.01 - p})
    if name == "support":
        sentences = {k: v for k, v in question["criteria"].items() if k != "none"}
        scores = {k: overlap(st.get("evidence", ""), v) for k, v in sentences.items()}
        best = max(scores, key=lambda k: scores[k]) if scores else None
        if best is None or scores[best] < 0.5:
            return choice_answer({**{k: 0.05 for k in sentences}, "none": 1.0})
        return choice_answer({**{k: 0.05 for k in sentences}, best: scores[best] + 0.5, "none": 0.1})
    if name == "relation":
        a = st.get("passage_a", {}).get("text", "") if isinstance(st.get("passage_a"), dict) else ""
        b = st.get("passage_b", {}).get("text", "") if isinstance(st.get("passage_b"), dict) else ""
        nums_a, nums_b = set(NUMBER.findall(a)), set(NUMBER.findall(b))
        neg_diff = bool(NEGATION.search(a)) != bool(NEGATION.search(b))
        if (nums_a and nums_b and nums_a != nums_b) or neg_diff:
            return choice_answer({"corroborates": 0.05, "contradicts": 0.8, "new_detail": 0.1, "unrelated": 0.05})
        ov = overlap(a, b)
        if ov < 0.1:
            return choice_answer({"corroborates": 0.05, "contradicts": 0.05, "new_detail": 0.2, "unrelated": 0.7})
        if ov > 0.5:
            return choice_answer({"corroborates": 0.7, "contradicts": 0.05, "new_detail": 0.2, "unrelated": 0.05})
        return choice_answer({"corroborates": 0.2, "contradicts": 0.05, "new_detail": 0.7, "unrelated": 0.05})
    if name == "orders_agent":
        hit = bool(ORDER_MARKERS.search(st.get("text", "")))
        return choice_answer({"A": 0.9, "B": 0.1} if hit else {"A": 0.1, "B": 0.9})
    if name == "changes":
        src = st.get("source", {}) if isinstance(st.get("source"), dict) else {}
        page = st.get("page", {}) if isinstance(st.get("page"), dict) else {}
        p = min(1.0, overlap(f"{page.get('title', '')}", f"{src.get('title', '')} {src.get('text', '')}"))
        return choice_answer({"A": p + 0.01, "B": 1.01 - p})
    if keys:
        return choice_answer({k: 1.0 for k in keys})
    return {"type": question.get("type", "noul"), "noul": 0.5}


def answer(request: dict) -> dict:
    """Answer every question in a System One request."""
    state = request.get("state")
    return {
        "model": FAKE_MODEL,
        "answers": {name: answer_question(name, q, state) for name, q in request["questions"].items()},
        "usage": {"input_tokens": 0, "output_tokens": 0},
    }


# Handler returns (status, body, delay_seconds). Body is a dict (sent as JSON) or a str.
Handler = Callable[[dict], tuple[int, object, float]]


def default_handler(request: dict) -> tuple[int, object, float]:
    return 200, answer(request), 0.0


def serve(handler: Handler = default_handler) -> tuple[ThreadingHTTPServer, str]:
    """Start a fake backend on 127.0.0.1. Returns (server, base_url). Call server.shutdown()."""
    requests: list[dict] = []

    class Fake(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
            status, payload, delay = handler(body)
            if delay:
                time.sleep(delay)
            data = payload if isinstance(payload, str) else json.dumps(payload)
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data.encode("utf-8"))
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *args):  # silence
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    server.daemon_threads = True
    server.requests = requests  # type: ignore[attr-defined]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"
