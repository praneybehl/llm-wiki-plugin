/**
 * Section split and search row helpers.
 *
 * Lexical ranking now runs in SQLite FTS5 (`bm25()`) inside the WikiDO. This
 * module keeps the parts that must match skills/llm-wiki/scripts/wiki_search.py
 * exactly:
 *   - `splitSections`: `split_sections` (ATX headings outside code fences).
 *   - `cachePageBody`: `cache_page_body` (page snippet text).
 *   - `collapseSnippet`: `collapse_snippet`.
 *   - `ftsQuery`: OR of quoted `[a-z0-9]+` tokens of the lowercased query.
 *   - `fuseRrf`: the reciprocal rank fusion of `cmd_search` (k = 60).
 */

import { tokenize } from "./frontmatter";

export const RRF_K = 60;
/** Lexical candidates that take part in fusion (`bm25_ranked[:50]`). */
export const LEXICAL_FUSION_DEPTH = 50;

export interface Section {
  headingPath: string[];
  level: number;
  text: string;
  sectionIndex: number;
}

/** Python `str.splitlines()` without line ends. */
export function pySplitLines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export function splitSections(title: string, body: string): Section[] {
  void title; // Kept for parity with the Python signature.
  const sections: Section[] = [];
  const headingStack: { level: number; text: string }[] = [];
  let headingPath: string[] = [];
  let level = 0;
  let lines: string[] = [];
  let inFence = false;

  const appendSection = (): void => {
    sections.push({
      headingPath: [...headingPath],
      level,
      text: lines.join("\n"),
      sectionIndex: sections.length,
    });
  };

  for (const line of pySplitLines(body)) {
    const stripped = line.trim();
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      inFence = !inFence;
      lines.push(line);
      continue;
    }
    const heading = inFence ? null : HEADING_RE.exec(line);
    if (!heading) {
      lines.push(line);
      continue;
    }

    appendSection();
    level = heading[1]!.length;
    const headingText = heading[2]!.trim();
    while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
      headingStack.pop();
    }
    headingStack.push({ level, text: headingText });
    headingPath = headingStack.map((item) => item.text);
    lines = [];
  }

  appendSection();
  return sections;
}

/** Text that the lexical and vector legs index for one section. */
export function searchableText(title: string, section: Pick<Section, "headingPath" | "text">): string {
  return `${title} ${section.headingPath.join(" ")} ${section.text}`;
}

export function cachePageBody(sections: Pick<Section, "headingPath" | "level" | "text">[]): string {
  const chunks: string[] = [];
  for (const section of sections) {
    if (section.headingPath.length > 0) {
      chunks.push(`${"#".repeat(section.level)} ${section.headingPath[section.headingPath.length - 1]}`);
    }
    chunks.push(section.text);
  }
  return chunks.join("\n");
}

export function collapseSnippet(text: string): string {
  return Array.from(text.trim().replace(/\s+/g, " ")).slice(0, 400).join("");
}

/** FTS5 MATCH expression, or null when the query has no tokens. */
export function ftsQuery(query: string): string | null {
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(" OR ");
}

export interface FusedRow<K> {
  key: K;
  score: number;
  retrievers: string[];
}

/**
 * `cmd_search` fusion: lexical top 50 first, then embedding-only keys, each
 * scored by the sum of 1 / (60 + rank); stable sort by score descending.
 */
export function fuseRrf<K>(lexical: K[], embedding: K[]): FusedRow<K>[] {
  const lexicalTop = lexical.slice(0, LEXICAL_FUSION_DEPTH);
  const lexicalRanks = new Map<K, number>();
  lexicalTop.forEach((key, index) => {
    if (!lexicalRanks.has(key)) lexicalRanks.set(key, index + 1);
  });
  const embeddingRanks = new Map<K, number>();
  embedding.forEach((key, index) => {
    if (!embeddingRanks.has(key)) embeddingRanks.set(key, index + 1);
  });
  const order: K[] = [];
  const seen = new Set<K>();
  for (const key of [...lexicalTop, ...embedding]) {
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  const rows = order.map((key) => {
    let score = 0;
    const retrievers: string[] = [];
    const lexicalRank = lexicalRanks.get(key);
    if (lexicalRank !== undefined) {
      score += 1 / (RRF_K + lexicalRank);
      retrievers.push("bm25");
    }
    const embeddingRank = embeddingRanks.get(key);
    if (embeddingRank !== undefined) {
      score += 1 / (RRF_K + embeddingRank);
      retrievers.push("embedding");
    }
    return { key, score, retrievers };
  });
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.score - a.row.score || a.index - b.index)
    .map(({ row }) => row);
}

/** Python `round(x, 4)` for display scores. */
export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
