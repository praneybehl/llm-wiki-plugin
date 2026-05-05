/**
 * BM25 search over wiki pages with frontmatter filters.
 *
 * Byte-for-byte parity with skills/llm-wiki/scripts/wiki_search.py:
 *   - Constants: k1 = 1.5, b = 0.75
 *   - Tokenizer: /[a-z0-9]+/ (lowercased)
 *   - IDF:       log(1 + (N - df + 0.5) / (df + 0.5))
 *   - Index:     built over the *filtered* page set, not the full corpus.
 *   - Skip:      SCHEMA.md, index.md, log.md at top level; indexes/, graph/
 *                directories; dotfiles.
 *
 * Parity is enforced by tests/lib/bm25.spec.ts against a snapshot captured
 * by tests/fixtures/_gen_bm25_expectations.py. If you change the algorithm,
 * regenerate the snapshot.
 */

import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
  parseFrontmatter,
  extractWikilinks,
  tokenize,
  type FrontmatterValue,
} from "./frontmatter.js";

const K1 = 1.5;
const B = 0.75;

const SKIP_TOP_LEVEL_FILES = new Set(["SCHEMA.md", "index.md", "log.md"]);
const SKIP_TOP_LEVEL_DIRS = new Set(["indexes", "graph"]);

export interface WikiPage {
  path: string;
  relPath: string;
  slug: string;
  meta: Record<string, FrontmatterValue>;
  body: string;
  tokens: string[];
  links: string[];
}

export interface SearchFilters {
  type?: string;
  tags?: string[];
  since?: string;
}

export interface SearchOptions {
  query: string;
  topK: number;
  filters?: SearchFilters;
}

export interface ScoredPage {
  score: number;
  page: WikiPage;
}

export interface TopLinkedRow {
  slug: string;
  count: number;
  broken: boolean;
}

/**
 * Returns true if `target`'s realpath stays under `realRoot`.
 *
 * Symlink containment: lstat first to detect symlinks; for any entry
 * (symlink or not) compute realpath and verify it stays under the wiki
 * root's realpath. This catches symlinks that point outside the wiki
 * tree, which a plain path.relative() check would miss because Node's
 * statSync follows symlinks transparently.
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
      // lstat: don't follow symlinks here. We always go through
      // realpathContained() which performs the actual containment check.
      let lst;
      try {
        lst = lstatSync(full);
      } catch {
        continue;
      }
      const isSymlink = lst.isSymbolicLink();
      // realpathContained: rejects entries whose real target escapes the
      // wiki root. For non-symlinks this is essentially identity-checking.
      if (realpathContained(realRoot, full) === null) continue;

      // After containment is confirmed, follow the symlink (or use lstat
      // for plain entries) to learn whether it's a directory or file.
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

function shouldSkip(rel: string): boolean {
  const parts = rel.split(sep);
  const first = parts[0];
  if (first === undefined) return true;
  if (parts.length === 1 && SKIP_TOP_LEVEL_FILES.has(first)) return true;
  if (SKIP_TOP_LEVEL_DIRS.has(first)) return true;
  if (parts[parts.length - 1]?.startsWith(".")) return true;
  return false;
}

function relPosix(root: string, full: string): string {
  return relative(root, full).split(sep).join("/");
}

function slugFromPath(full: string): string {
  const name = full.split(sep).pop() ?? "";
  return name.replace(/\.md$/, "");
}

export function pageFromText(
  fullPath: string,
  relPath: string,
  text: string,
): WikiPage {
  const { meta, body } = parseFrontmatter(text);
  const titleValue = meta["title"];
  const title = typeof titleValue === "string" ? titleValue : "";
  return {
    path: fullPath,
    relPath,
    slug: slugFromPath(fullPath),
    meta,
    body,
    tokens: tokenize(`${body} ${title}`),
    links: extractWikilinks(body),
  };
}

export function collectPages(wikiRoot: string): WikiPage[] {
  const files = listMarkdownFilesSorted(wikiRoot);
  const pages: WikiPage[] = [];
  for (const full of files) {
    const rel = relative(wikiRoot, full);
    if (shouldSkip(rel)) continue;
    let text: string;
    try {
      text = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    pages.push(pageFromText(full, relPosix(wikiRoot, full), text));
  }
  return pages;
}

interface Bm25Index {
  N: number;
  df: Map<string, number>;
  avgdl: number;
  docLens: number[];
  termFreqs: Map<string, number>[];
}

function buildIndex(pages: WikiPage[]): Bm25Index {
  const N = pages.length;
  const df = new Map<string, number>();
  const docLens: number[] = [];
  const termFreqs: Map<string, number>[] = [];

  for (const page of pages) {
    docLens.push(page.tokens.length);
    const tf = new Map<string, number>();
    for (const term of page.tokens) {
      tf.set(term, (tf.get(term) ?? 0) + 1);
    }
    termFreqs.push(tf);
    for (const term of tf.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const totalLen = docLens.reduce((a, b) => a + b, 0);
  const avgdl = N === 0 ? 0 : totalLen / N;

  return { N, df, avgdl, docLens, termFreqs };
}

function score(idx: Bm25Index, docIdx: number, queryTokens: string[]): number {
  const { N, df, avgdl, docLens, termFreqs } = idx;
  const dl = docLens[docIdx] ?? 0;
  const tf = termFreqs[docIdx];
  if (!tf) return 0;

  let s = 0;
  for (const term of queryTokens) {
    const dft = df.get(term);
    if (dft === undefined) continue;
    const f = tf.get(term) ?? 0;
    if (f === 0) continue;
    const idf = Math.log(1 + (N - dft + 0.5) / (dft + 0.5));
    const denom = f + K1 * (1 - B + B * (avgdl === 0 ? 1 : dl / avgdl));
    s += (idf * (f * (K1 + 1))) / denom;
  }
  return s;
}

function parseDate(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(m[1] + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}

function passesFilters(page: WikiPage, filters: SearchFilters): boolean {
  const { meta } = page;
  if (filters.type !== undefined) {
    const t = meta["type"];
    if (typeof t !== "string" || t !== filters.type) return false;
  }
  if (filters.tags && filters.tags.length > 0) {
    const raw = meta["tags"];
    const tags = Array.isArray(raw) ? raw : [];
    for (const required of filters.tags) {
      if (!tags.includes(required)) return false;
    }
  }
  if (filters.since !== undefined) {
    const since = parseDate(filters.since);
    const updated = parseDate(meta["updated"]);
    if (since && !updated) return false;
    if (since && updated && updated < since) return false;
  }
  return true;
}

export function searchPages(
  pages: WikiPage[],
  opts: SearchOptions,
): ScoredPage[] {
  const filters = opts.filters ?? {};
  const filtered = pages.filter((p) => passesFilters(p, filters));
  if (filtered.length === 0) return [];

  const queryTokens = tokenize(opts.query);
  if (queryTokens.length === 0) return [];

  const idx = buildIndex(filtered);

  const scored: ScoredPage[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const page = filtered[i];
    if (!page) continue;
    const s = score(idx, i, queryTokens);
    scored.push({ score: s, page });
  }

  // Stable sort by descending score; ties keep collection order, matching
  // Python's sorted(..., key=lambda x: -x[0]).
  scored.sort((a, b) => b.score - a.score);

  return scored.filter((r) => r.score > 0).slice(0, opts.topK);
}

export function backlinks(pages: WikiPage[], target: string): WikiPage[] {
  return pages.filter((p) => p.links.includes(target));
}

export function topLinked(pages: WikiPage[], topN: number): TopLinkedRow[] {
  const counts = new Map<string, number>();
  // First-seen order matters for ties — iterate pages, then their links.
  for (const page of pages) {
    for (const link of page.links) {
      counts.set(link, (counts.get(link) ?? 0) + 1);
    }
  }

  const slugSet = new Set(pages.map((p) => p.slug));

  // Map iteration preserves insertion order. Stable sort by count desc keeps
  // first-seen order on ties (matches Python's Counter.most_common).
  const rows: TopLinkedRow[] = [];
  for (const [slug, count] of counts) {
    rows.push({ slug, count, broken: !slugSet.has(slug) });
  }
  rows.sort((a, b) => b.count - a.count);

  return rows.slice(0, topN);
}
