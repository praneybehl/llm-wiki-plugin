/**
 * Quick summary of wiki size, shape, and link density.
 *
 * Byte-for-byte parity with skills/llm-wiki/scripts/wiki_stats.py:
 *   - Skip rules: SCHEMA.md, log.md, README.md at top level (NOT index.md —
 *     index.md content is read for indexLines and excluded from page stats).
 *     indexes/, graph/, raw/ directories skipped. Dotfiles skipped.
 *   - pages by type from frontmatter `type:` field.
 *   - pages by directory: top-level dir name, or "(root)" for top-level pages.
 *   - link density = totalLinks / totalPages.
 *   - largest pages sorted desc by line count.
 *   - most-linked-in: count of inbound [[wikilink]] references per slug.
 *
 * Scaling messages emitted (per Python lines 140-151):
 *   totalPages < 50                                 → "Below first threshold"
 *   50 ≤ totalPages < 150 AND indexLines < 300      → "Below shard threshold"
 *   (totalPages ≥ 150 OR indexLines ≥ 300)
 *     AND no `indexes/` dir                         → "AT SHARD THRESHOLD"
 *   totalPages ≥ 300                                → "past 300"
 *   totalPages ≥ 500                                → "past 500" + "lint weekly"
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
  parseFrontmatter,
  extractWikilinks,
} from "./frontmatter.js";

/**
 * Symlink containment helper — see src/lib/bm25.ts for the rationale.
 */
function realpathContained(realRoot: string, target: string): string | null {
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    return null;
  }
  if (realTarget === realRoot) return realTarget;
  if (!realTarget.startsWith(realRoot + sep)) return null;
  return realTarget;
}

const SKIP_TOP_LEVEL_FILES = new Set(["SCHEMA.md", "log.md", "README.md"]);
const SKIP_TOP_LEVEL_DIRS = new Set(["indexes", "graph", "raw"]);

export interface StatsResult {
  totalPages: number;
  totalLines: number;
  totalWords: number;
  totalLinks: number;
  avgLinesPerPage: number;
  avgWordsPerPage: number;
  linkDensity: number;
  indexLines: number;
  pagesByType: Record<string, number>;
  pagesByDirectory: Record<string, number>;
  largest: { lines: number; path: string }[];
  mostLinkedIn: { slug: string; count: number }[];
  scalingMessages: string[];
}

export interface StatsOptions {
  topLargest?: number;     // default 10
  topMostLinked?: number;  // default 10
}

function listMarkdownFilesSorted(root: string): string[] {
  const out: string[] = [];

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return out;
  }

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    entries.sort();
    for (const name of entries) {
      const full = join(dir, name);
      let lst;
      try {
        lst = lstatSync(full);
      } catch {
        continue;
      }
      const isSymlink = lst.isSymbolicLink();
      if (realpathContained(realRoot, full) === null) continue;

      let isDir: boolean;
      let isFile: boolean;
      if (isSymlink) {
        try {
          const stat = lstatSync(realpathSync(full));
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      } else {
        isDir = lst.isDirectory();
        isFile = lst.isFile();
      }

      if (isDir) {
        walk(full);
      } else if (isFile && name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

function lineCount(text: string): number {
  return (text.match(/\n/g)?.length ?? 0) + 1;
}

function relPosix(root: string, full: string): string {
  return relative(root, full).split(sep).join("/");
}

export function computeStats(
  root: string,
  opts: StatsOptions = {},
): StatsResult {
  const topLargest = opts.topLargest ?? 10;
  const topMostLinked = opts.topMostLinked ?? 10;

  let totalPages = 0;
  let totalLines = 0;
  let totalWords = 0;
  let totalLinks = 0;
  let indexLines = 0;
  const pagesByType: Record<string, number> = {};
  const pagesByDirectory: Record<string, number> = {};
  const largestAll: { lines: number; path: string }[] = [];
  const mostLinkedCounts = new Map<string, number>();

  const files = listMarkdownFilesSorted(root);
  for (const full of files) {
    const rel = relative(root, full);
    const parts = rel.split(sep);
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first === undefined) continue;

    // index.md at top level: read for indexLines, then skip from page stats.
    if (parts.length === 1 && first === "index.md") {
      try {
        indexLines = lineCount(readFileSync(full, "utf-8"));
      } catch {
        // unreadable index.md → leave indexLines at 0
      }
      continue;
    }

    if (parts.length === 1 && SKIP_TOP_LEVEL_FILES.has(first)) continue;
    if (SKIP_TOP_LEVEL_DIRS.has(first)) continue;
    if (last !== undefined && last.startsWith(".")) continue;

    let text: string;
    try {
      text = readFileSync(full, "utf-8");
    } catch {
      continue;
    }

    totalPages += 1;
    const lines = lineCount(text);
    const words = text.split(/\s+/).filter(Boolean).length;
    totalLines += lines;
    totalWords += words;

    const { meta, body } = parseFrontmatter(text);

    const links = extractWikilinks(body);
    totalLinks += links.length;
    for (const link of links) {
      mostLinkedCounts.set(link, (mostLinkedCounts.get(link) ?? 0) + 1);
    }

    const typeRaw = meta["type"];
    const type = typeof typeRaw === "string" && typeRaw.length > 0 ? typeRaw : "(none)";
    pagesByType[type] = (pagesByType[type] ?? 0) + 1;

    const dirKey = parts.length > 1 ? first : "(root)";
    pagesByDirectory[dirKey] = (pagesByDirectory[dirKey] ?? 0) + 1;

    largestAll.push({ lines, path: relPosix(root, full) });
  }

  largestAll.sort((a, b) => b.lines - a.lines);
  const largest = largestAll.slice(0, topLargest);

  // First-seen order on count ties (matches Python Counter.most_common).
  const mostLinkedIn = Array.from(mostLinkedCounts.entries())
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topMostLinked);

  const avgLinesPerPage = totalPages === 0 ? 0 : Math.floor(totalLines / totalPages);
  const avgWordsPerPage = totalPages === 0 ? 0 : Math.floor(totalWords / totalPages);
  const linkDensity = totalPages === 0 ? 0 : totalLinks / totalPages;

  // Scaling messages (parity with wiki_stats.py:140-151).
  const scalingMessages: string[] = [];
  const indexesDirExists = existsSync(join(root, "indexes"));

  // Mirror Python's if/elif chain in wiki_stats.py:140-151. The "Past 300"
  // branch is the fallback when the operator already has an `indexes/` dir
  // (so AT SHARD THRESHOLD doesn't fire). The "Past 500" check is a separate
  // top-level if, always evaluated after the chain.
  if (totalPages < 50) {
    scalingMessages.push("Below first threshold. Flat structure is fine.");
  } else if (totalPages < 150 && indexLines < 300) {
    scalingMessages.push("Below shard threshold. Continue with single index.md.");
  } else if (
    (totalPages >= 150 || indexLines >= 300) &&
    !indexesDirExists
  ) {
    scalingMessages.push(
      "AT SHARD THRESHOLD. Consider sharding index.md into wiki/indexes/<type>.md.",
    );
  } else if (totalPages >= 300) {
    scalingMessages.push("Past 300 pages. Use wiki search as a routine fallback.");
  }
  if (totalPages >= 500) {
    scalingMessages.push("Past 500 pages. Run lint weekly or per-N-ingests.");
  }

  return {
    totalPages,
    totalLines,
    totalWords,
    totalLinks,
    avgLinesPerPage,
    avgWordsPerPage,
    linkDensity,
    indexLines,
    pagesByType,
    pagesByDirectory,
    largest,
    mostLinkedIn,
    scalingMessages,
  };
}
