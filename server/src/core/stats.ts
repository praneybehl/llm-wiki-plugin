/**
 * Wiki size, shape and link density. Port of skills/llm-wiki/scripts/wiki_stats.py
 * over in-memory page records, returned as JSON instead of text.
 *
 * Python skips top-level SCHEMA.md, log.md, README.md and the dirs indexes/,
 * graph/, raw/, .evolution/, plus dotfiles; top-level index.md only feeds
 * `index_lines`. The server also skips .wiki-cache/ (shared exclusion list).
 */

import { extractWikilinks } from "./frontmatter";

export interface StatsPage {
  path: string;
  lineCount: number;
  wordCount: number;
  /** `parse_type` result: first `type:` line of the frontmatter. */
  statsType: string | null;
  links: string[];
}

export interface StatsResult {
  pages: number;
  total_lines: number;
  total_words: number;
  total_links: number;
  avg_lines_per_page: number;
  avg_words_per_page: number;
  link_density: number;
  index_lines: number;
  shard_recommended: boolean;
  pages_by_type: { type: string; pages: number }[];
  pages_by_directory: { directory: string; pages: number }[];
  largest: { path: string; lines: number; warning: "over_hard_cap" | "over_soft_cap" | null }[];
  most_linked: { slug: string; count: number }[];
  scaling: string[];
}

/** Popularity key: the page stem a link names, without checking it resolves. */
export function linkStem(link: string): string {
  let target = link.split("|", 1)[0] ?? "";
  target = target.split("#", 1)[0] ?? "";
  target = target.replaceAll("\\", "/").trim().replace(/^\/+|\/+$/g, "");
  target = target.split("/").pop() ?? "";
  if (target.toLowerCase().endsWith(".md")) target = target.slice(0, -3);
  return target.trim();
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

export function parseStatsType(text: string): string | null {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return null;
  for (const line of (m[1] ?? "").split("\n")) {
    const kv = /^type:\s*([^\n]*)$/.exec(line);
    if (kv) return pyStripQuotes((kv[1] ?? "").trim());
  }
  return null;
}

function pyStripQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
}

/** Body wikilinks; frontmatter stripped only when the text starts with `---`. */
export function statsLinks(text: string): string[] {
  const body = text.startsWith("---") ? text.replace(FRONTMATTER_RE, "") : text;
  return extractWikilinks(body);
}

/** Python `len(text.split())`. */
export function wordCount(text: string): number {
  return text.split(/[\s\u001c-\u001f]+/).filter((word) => word.length > 0).length;
}

/** Python `Counter.most_common()`: count descending, first-seen order on ties. */
function mostCommon(counts: Map<string, number>): [string, number][] {
  return [...counts.entries()]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry[1] - a.entry[1] || a.index - b.index)
    .map(({ entry }) => entry);
}

/** `pages` excludes index.md; `indexLines` is the line count of top-level index.md. */
export function computeStats(pages: StatsPage[], indexLines: number, hasIndexesDir: boolean): StatsResult {
  let totalLines = 0;
  let totalWords = 0;
  let totalLinks = 0;
  const byType = new Map<string, number>();
  const byDir = new Map<string, number>();
  const linked = new Map<string, number>();
  const largest: [number, string][] = [];

  for (const page of pages) {
    totalLines += page.lineCount;
    totalWords += page.wordCount;
    totalLinks += page.links.length;
    for (const link of page.links) {
      const stem = linkStem(link);
      linked.set(stem, (linked.get(stem) ?? 0) + 1);
    }
    const type = page.statsType || "(none)";
    byType.set(type, (byType.get(type) ?? 0) + 1);
    const parts = page.path.split("/");
    const dir = parts.length > 1 ? parts[0]! : "(root)";
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
    largest.push([page.lineCount, page.path]);
  }
  // Python: largest.sort(reverse=True) on (lines, path) tuples.
  largest.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));

  const total = pages.length;
  const scaling: string[] = [];
  if (total < 50) {
    scaling.push("Below first threshold. Flat structure is fine.");
  } else if (total < 150 && indexLines < 300) {
    scaling.push("Below shard threshold. Continue with single index.md.");
  } else if ((total >= 150 || indexLines >= 300) && !hasIndexesDir) {
    scaling.push("AT SHARD THRESHOLD. Consider sharding index.md into wiki/indexes/<type>.md.");
    scaling.push("See references/scaling-playbook.md.");
  } else if (total >= 300) {
    scaling.push("Past 300 pages. Use scripts/wiki_search.py as a routine fallback.");
  }
  if (total >= 500) scaling.push("Past 500 pages. Run lint weekly or per-N-ingests.");

  return {
    pages: total,
    total_lines: totalLines,
    total_words: totalWords,
    total_links: totalLinks,
    avg_lines_per_page: total ? Math.floor(totalLines / total) : 0,
    avg_words_per_page: total ? Math.floor(totalWords / total) : 0,
    link_density: total ? Math.round((totalLinks / total) * 10) / 10 : 0,
    index_lines: indexLines,
    shard_recommended: indexLines > 300,
    pages_by_type: mostCommon(byType).map(([type, count]) => ({ type, pages: count })),
    pages_by_directory: mostCommon(byDir).map(([directory, count]) => ({ directory, pages: count })),
    largest: largest.slice(0, 10).map(([lines, path]) => ({
      path,
      lines,
      warning: lines > 800 ? "over_hard_cap" : lines > 400 ? "over_soft_cap" : null,
    })),
    most_linked: mostCommon(linked)
      .slice(0, 10)
      .map(([slug, count]) => ({ slug, count })),
    scaling,
  };
}
