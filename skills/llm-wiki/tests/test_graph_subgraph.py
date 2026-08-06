"""How are these pages related? -- the question a retrieval result raises.

Every other subcommand takes exactly one node, so answering it meant one
`edges --subject` call per page plus hand-filtering the objects back down to
the set, over output where implicit `mentions` is the majority. `subgraph`
answers it in one call, in three layers, weakest last: direct edges inside the
set, then a shared connector two or more members reach, then -- for terms with
neither -- the chain running between them.

The negatives are load-bearing and tested as such. "Both matched and are
unrelated" is a finding; an empty edge list alone cannot be told apart from a
set that was never in the graph.
"""

from __future__ import annotations

import argparse
import io
import json
import contextlib
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import wiki_graph_query  # noqa: E402


def _concept_node(slug: str, *, aliases: tuple[str, ...] = ()) -> dict:
    return {"id": f"concept:{slug}", "slug": slug, "title": slug.upper(),
            "page_type": "concept", "node_type": "concept", "kind": "", "tags": [],
            "aliases": list(aliases), "path": f"concepts/{slug}.md",
            "created": "", "updated": "", "canonical": True}


def _graph_edge(edge_id: str, subject: str, predicate: str, obj: str,
                evidence: str = "") -> dict:
    return {"id": edge_id, "subject": subject, "predicate": predicate, "object": obj,
            "source": "report" if evidence else "", "evidence": evidence,
            "confidence": "high" if evidence else "low", "status": "current",
            "extraction_method": "frontmatter" if evidence else "wikilink",
            "page": f"{subject.split(':', 1)[-1]}.md", "extras": {}}


class GraphSubgraphTests(unittest.TestCase):
    """`subgraph` answers the one question a result set actually raises.

    Every other subcommand takes a single node, so "how are the pages I just
    retrieved related to each other" cost one `edges --subject` call per page
    plus hand-filtering the objects back down to the set. The edges that leave
    the set are the majority and none of them answer that question.
    """

    NODES = [
        {"id": "concept:a", "slug": "a", "title": "A", "page_type": "concept",
         "node_type": "concept", "kind": "", "tags": [], "aliases": ["Alpha"],
         "path": "concepts/a.md", "created": "", "updated": "", "canonical": True},
        {"id": "concept:b", "slug": "b", "title": "B", "page_type": "concept",
         "node_type": "concept", "kind": "", "tags": [], "aliases": ["Shared"],
         "path": "concepts/b.md", "created": "", "updated": "", "canonical": True},
        {"id": "concept:c", "slug": "c", "title": "C", "page_type": "concept",
         "node_type": "concept", "kind": "", "tags": [], "aliases": ["Shared"],
         "path": "concepts/c.md", "created": "", "updated": "", "canonical": True},
        {"id": "concept:lonely", "slug": "lonely", "title": "Lonely",
         "page_type": "concept", "node_type": "concept", "kind": "", "tags": [],
         "aliases": [], "path": "concepts/lonely.md", "created": "", "updated": "",
         "canonical": True},
        {"id": "document:docs/x.md", "slug": "docs/x.md", "title": "x.md",
         "page_type": "", "node_type": "document", "kind": "", "tags": [],
         "aliases": [], "path": "docs/x.md", "created": "", "updated": "",
         "canonical": False},
    ] + [
        # The shared-connector shape: x, y, z all touch mid, none touches another.
        _concept_node(slug) for slug in
        ("x", "y", "z", "mid",
         # Two hops apart: far-a — n1 — far-hop — n2 — far-b.
         "far-a", "far-b", "far-hop", "n1", "n2",
         # A hub: adjacent to more members than a specific connector would be.
         "hub", "h1", "h2", "h3",
         # Joined only by an implicit `mentions` route.
         "m1", "m2", "gossip",
         # Reachable from each other only *through* the hub.
         "bridged-a", "bridged-b")
    ]
    EDGES = [
        {"id": "e1", "subject": "concept:a", "predicate": "depends_on",
         "object": "concept:b", "source": "", "evidence": "", "confidence": "high",
         "status": "current", "extraction_method": "frontmatter",
         "page": "concepts/a.md", "extras": {}},
        {"id": "e2", "subject": "concept:b", "predicate": "mentions",
         "object": "concept:c", "source": "", "evidence": "", "confidence": "low",
         "status": "current", "extraction_method": "wikilink",
         "page": "concepts/b.md", "extras": {}},
        # Leaves the set: the noise `subgraph` exists to drop.
        {"id": "e3", "subject": "concept:a", "predicate": "sourced_from",
         "object": "document:docs/x.md", "source": "docs/x.md", "evidence": "",
         "confidence": "high", "status": "current",
         "extraction_method": "frontmatter_sources", "page": "concepts/a.md",
         "extras": {}},
        _graph_edge("c1", "concept:x", "depends_on", "concept:mid",
                    "x consumes the mid estimate"),
        _graph_edge("c2", "concept:y", "relates_to", "concept:mid", "y derives from mid"),
        _graph_edge("c3", "concept:z", "relates_to", "concept:mid", "z derives from mid"),
        _graph_edge("f1", "concept:far-a", "relates_to", "concept:n1", "a—n1"),
        _graph_edge("f2", "concept:n1", "relates_to", "concept:far-hop", "n1—hop"),
        _graph_edge("f3", "concept:far-hop", "relates_to", "concept:n2", "hop—n2"),
        _graph_edge("f4", "concept:n2", "relates_to", "concept:far-b", "n2—b"),
        _graph_edge("g1", "concept:hub", "relates_to", "concept:h1", "hub—h1"),
        _graph_edge("g2", "concept:hub", "relates_to", "concept:h2", "hub—h2"),
        _graph_edge("g3", "concept:hub", "relates_to", "concept:h3", "hub—h3"),
        _graph_edge("n_1", "concept:m1", "mentions", "concept:gossip"),
        _graph_edge("n_2", "concept:m2", "mentions", "concept:gossip"),
        _graph_edge("b1", "concept:bridged-a", "relates_to", "concept:hub", "a—hub"),
        _graph_edge("b2", "concept:bridged-b", "relates_to", "concept:hub", "b—hub"),
    ]

    def _conn(self, root: Path) -> sqlite3.Connection:
        graph = root / "graph"
        graph.mkdir(parents=True)
        with (graph / "nodes.jsonl").open("w", encoding="utf-8") as handle:
            for node in self.NODES:
                handle.write(json.dumps(node, sort_keys=True) + "\n")
        with (graph / "edges.jsonl").open("w", encoding="utf-8") as handle:
            for edge in self.EDGES:
                handle.write(json.dumps(edge, sort_keys=True) + "\n")
        with contextlib.redirect_stderr(io.StringIO()):
            return wiki_graph_query.open_db(graph / "graph.sqlite", graph)

    def _subgraph(self, conn, nodes: list[str], predicate: str | None = None,
                  radius: int | None = 0, max_connector_degree: int = 25,
                  include_mentions: bool = False, max_chain_hops: int = 0) -> dict:
        """`radius=0` and no chains by default: most cases pin the induced half."""
        return wiki_graph_query.cmd_subgraph(
            conn, argparse.Namespace(
                nodes=nodes, predicate=predicate, radius=radius,
                max_connector_degree=max_connector_degree,
                include_mentions=include_mentions, max_chain_hops=max_chain_hops,
            )
        )

    def test_only_edges_with_both_ends_in_the_set_are_returned(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:a,concept:b,concept:c"])
                self.assertEqual(
                    [("concept:a", "depends_on", "concept:b"),
                     ("concept:b", "mentions", "concept:c")],
                    [(e["subject"], e["predicate"], e["object"]) for e in result["edges"]],
                )
                # e3's object is outside the set, so it never appears.
                self.assertNotIn("sourced_from", [e["predicate"] for e in result["edges"]])
            finally:
                conn.close()

    def test_predicate_filter_narrows_to_the_typed_layer(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:a,concept:b,concept:c"],
                                        predicate="depends_on")
                self.assertEqual(1, len(result["edges"]))
                self.assertEqual("depends_on", result["edges"][0]["predicate"])
            finally:
                conn.close()

    def test_a_node_with_no_internal_edge_is_reported_as_isolated(self):
        """The informative negative: both pages matched and are unrelated."""
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:a,concept:b,concept:lonely"])
                self.assertEqual(["concept:lonely"], result["isolated"])
            finally:
                conn.close()

    def test_bare_slugs_resolve_because_search_reports_slugs(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                by_slug = self._subgraph(conn, ["a,b"])
                by_id = self._subgraph(conn, ["concept:a,concept:b"])
                self.assertEqual(
                    [e["id"] for e in by_id["edges"]], [e["id"] for e in by_slug["edges"]]
                )
                self.assertEqual(["concept:a", "concept:b"],
                                 [n["id"] for n in by_slug["nodes"]])
            finally:
                conn.close()

    def test_a_unique_alias_resolves_and_an_ambiguous_one_does_not(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                self.assertEqual("concept:a", wiki_graph_query.resolve_node_id(conn, "Alpha"))
                # "Shared" names both b and c: picking one silently would be a lie.
                self.assertIsNone(wiki_graph_query.resolve_node_id(conn, "Shared"))
            finally:
                conn.close()

    def test_one_unknown_token_is_reported_without_losing_the_rest(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:a", "concept:b,concept:ghost"])
                self.assertEqual(["concept:ghost"], result["unresolved"])
                self.assertEqual(1, len(result["edges"]))
            finally:
                conn.close()

    def test_the_same_node_named_twice_is_counted_once(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:a,a,Alpha"])
                self.assertEqual(1, len(result["nodes"]))
                self.assertEqual(3, len(result["requested"]))
            finally:
                conn.close()

    def test_repeated_query_reuses_the_temp_table_without_leaking_rows(self):
        """`--nodes` twice in one process must not union the two sets."""
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                self._subgraph(conn, ["concept:a,concept:b"])
                second = self._subgraph(conn, ["concept:b,concept:c"])
                self.assertEqual(
                    [("concept:b", "mentions", "concept:c")],
                    [(e["subject"], e["predicate"], e["object"]) for e in second["edges"]],
                )
            finally:
                conn.close()

    def test_all_tokens_unknown_exits_one(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                buffer = io.StringIO()
                with contextlib.redirect_stderr(buffer):
                    with self.assertRaises(SystemExit) as exit_context:
                        self._subgraph(conn, ["ghost,phantom"])
                self.assertEqual(1, exit_context.exception.code)
                self.assertIn("none of the requested nodes", buffer.getvalue())
            finally:
                conn.close()

    def test_an_empty_node_list_exits_two(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                with contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as exit_context:
                        self._subgraph(conn, [" , "])
                self.assertEqual(2, exit_context.exception.code)
            finally:
                conn.close()

    def test_a_shared_connector_is_found_without_being_asked_for(self):
        """The point of the default: three members, no direct edge, one shared step."""
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:x,concept:y,concept:z"], radius=None)
                self.assertEqual(1, result["radius"])
                self.assertEqual(["concept:mid"], [c["id"] for c in result["connectors"]])
                self.assertEqual(3, len(result["connectors"][0]["joins"]))
                self.assertEqual([], result["isolated"])
            finally:
                conn.close()

    def test_a_connector_reached_from_only_one_member_is_not_one(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:x,concept:lonely"], radius=1)
                self.assertEqual([], [c["id"] for c in result["connectors"]])
            finally:
                conn.close()

    def test_radius_widens_only_when_the_close_search_finds_nothing(self):
        """`far` sits two hops from x and y — invisible at radius 1, found at 2."""
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                near = self._subgraph(conn, ["concept:far-a,concept:far-b"], radius=1)
                self.assertEqual([], [c["id"] for c in near["connectors"]])

                auto = self._subgraph(conn, ["concept:far-a,concept:far-b"], radius=None)
                self.assertEqual(2, auto["radius"])
                self.assertIn("concept:far-hop", [c["id"] for c in auto["connectors"]])
            finally:
                conn.close()

    def test_a_hub_is_excluded_and_reported_rather_than_hidden(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                capped = self._subgraph(conn, ["concept:h1,concept:h2"],
                                        radius=1, max_connector_degree=2)
                self.assertEqual([], [c["id"] for c in capped["connectors"]])
                self.assertEqual(["concept:hub"], [h["id"] for h in capped["excluded_hubs"]])

                uncapped = self._subgraph(conn, ["concept:h1,concept:h2"],
                                          radius=1, max_connector_degree=0)
                self.assertEqual(["concept:hub"], [c["id"] for c in uncapped["connectors"]])
            finally:
                conn.close()

    def test_a_hub_may_not_be_walked_through(self):
        """Regression: excluding a hub as a candidate is not enough.

        `bridged-a` and `bridged-b` touch nothing but the hub. If the walk may
        pass through it, every other neighbour of the hub becomes "reachable from
        both members" at radius 2, and the command answers a relational question
        with most of the corpus — measured at a median of 193 connectors per
        random triple on the real graph before this was fixed.
        """
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:bridged-a,concept:bridged-b"],
                                        radius=None, max_connector_degree=4)
                self.assertEqual([], [c["id"] for c in result["connectors"]])
                self.assertEqual(["concept:hub"], [h["id"] for h in result["excluded_hubs"]])
                self.assertEqual(2, result["radius"], "should have widened and still found none")
            finally:
                conn.close()

    def test_mentions_routes_are_off_by_default_and_opt_in(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                typed_only = self._subgraph(conn, ["concept:m1,concept:m2"], radius=1)
                self.assertEqual([], [c["id"] for c in typed_only["connectors"]])

                widened = self._subgraph(conn, ["concept:m1,concept:m2"], radius=1,
                                         include_mentions=True)
                self.assertEqual(["concept:gossip"], [c["id"] for c in widened["connectors"]])
            finally:
                conn.close()

    def test_connector_edges_carry_their_evidence_into_the_result(self):
        """Without the edges the connector is an assertion; with them it is sourced."""
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:x,concept:y,concept:z"], radius=None)
                evidence = [e["evidence"] for e in result["edges"] if e["evidence"]]
                self.assertIn("x consumes the mid estimate", evidence)
            finally:
                conn.close()

    def test_distant_terms_come_back_as_a_chain(self):
        """The primary case: far-a and far-b share no neighbour, only a route.

        `far-a — n1 — far-hop — n2 — far-b` is four hops. A connector search can
        never express it, which is why chains exist.
        """
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:far-a,concept:far-b"],
                                        radius=None, max_chain_hops=4)
                self.assertEqual(1, len(result["chains"]))
                chain = result["chains"][0]
                self.assertEqual(
                    ["concept:far-a", "concept:n1", "concept:far-hop",
                     "concept:n2", "concept:far-b"], chain["nodes"])
                self.assertEqual(4, chain["hops"])
                self.assertEqual("typed", chain["scope"])
                self.assertEqual(4, len(chain["edges"]))
            finally:
                conn.close()

    def test_the_route_nodes_join_the_reported_subgraph(self):
        """'Bounded by the terms' means the intermediates are part of the answer."""
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:far-a,concept:far-b"],
                                        radius=None, max_chain_hops=4)
                subjects = {edge["subject"] for edge in result["edges"]}
                objects = {edge["object"] for edge in result["edges"]}
                self.assertIn("concept:far-hop", subjects | objects)
            finally:
                conn.close()

    def test_a_pair_beyond_the_limit_reports_its_distance_not_silence(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:far-a,concept:far-b"],
                                        radius=None, max_chain_hops=2)
                self.assertEqual([], result["chains"])
                self.assertEqual(
                    [{"from": "concept:far-a", "to": "concept:far-b",
                      "beyond_limit_hops": 4, "scope": "typed+mentions"}],
                    result["unreachable"],
                )
            finally:
                conn.close()

    def test_a_route_that_needs_wikilinks_says_so(self):
        """m1 and m2 are joined only by `mentions`; the chain must not hide that."""
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:m1,concept:m2"],
                                        radius=None, max_chain_hops=4)
                self.assertEqual(1, len(result["chains"]))
                self.assertEqual("typed+mentions", result["chains"][0]["scope"])
                self.assertEqual("mentions", result["chains"][0]["weakest"])
            finally:
                conn.close()

    def test_a_chain_may_not_run_through_a_hub(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:bridged-a,concept:bridged-b"],
                                        radius=None, max_chain_hops=4,
                                        max_connector_degree=4)
                self.assertEqual([], result["chains"])
                self.assertEqual([], result["unreachable"],
                                 "a hub route is no route, not a longer one")
            finally:
                conn.close()

    def test_chains_are_off_when_the_hop_limit_is_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(conn, ["concept:far-a,concept:far-b"],
                                        radius=None, max_chain_hops=0)
                self.assertEqual([], result["chains"])
            finally:
                conn.close()

    def test_render_names_the_isolated_and_the_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = self._conn(Path(directory))
            try:
                result = self._subgraph(
                    conn, ["concept:a,concept:b,concept:lonely,concept:ghost"]
                )
                text = wiki_graph_query.render(result, "subgraph")
                self.assertIn("Unconnected even through a connector: concept:lonely", text)
                self.assertIn("Not in the graph: concept:ghost", text)
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
