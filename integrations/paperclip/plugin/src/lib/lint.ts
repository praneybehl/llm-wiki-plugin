/**
 * Structural health check for an LLM Wiki.
 *
 * Byte-for-byte parity with skills/llm-wiki/scripts/wiki_lint.py:119-241:
 *   - Categories: orphans, brokenLinks, oversizedHard, oversizedSoft,
 *     missingFrontmatter, malformedFrontmatter, duplicateSlugs, stalePages,
 *     readErrors.
 *   - Defaults: softCap 400, hardCap 800 lines; staleness >90d for hubs
 *     with ≥3 inbound; required fm fields = type, title, tags, created,
 *     updated.
 *   - Skip rules: SCHEMA.md, index.md, log.md, README.md at top level,
 *     plus indexes/, graph/ directories and dotfiles.
 *
 * Conservative — reports findings, never edits.
 *
 * NOTE: --suggest-pages capitalized-phrase mining (Python lines 198-226) is
 * deliberately not ported in v0.1; defer to v0.2 if operator demand surfaces.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  parseFrontmatter,
  extractWikilinks,
  type FrontmatterValue,
} from "./frontmatter.js";

const DEFAULT_SOFT_CAP = 400;
const DEFAULT_HARD_CAP = 800;
const DEFAULT_STALE_DAYS = 90;
const DEFAULT_STALE_MIN_INBOUND = 3;
const DEFAULT_REQUIRED_FM = ["type", "title", "tags", "created", "updated"];

const SKIP_TOP_LEVEL_FILES = new Set([
  "SCHEMA.md",
  "index.md",
  "log.md",
  "README.md",
]);
const SKIP_TOP_LEVEL_DIRS = new Set(["indexes", "graph"]);

export interface LintOptions {
  softCap?: number;
  hardCap?: number;
  requiredFm?: string[];
  staleDays?: number;
  staleMinInbound?: number;
}

export interface OrphanFinding {
  slug: string;
  path: string;
}
export interface BrokenLinkFinding {
  from: string;
  fromPath: string;
  to: string;
}
export interface OversizeFinding {
  path: string;
  lines: number;
}
export interface MissingFmFinding {
  path: string;
  missing: string[];
}
export interface MalformedFmFinding {
  path: string;
}
export interface DuplicateSlugFinding {
  slug: string;
  paths: string[];
}
export interface StaleFinding {
  path: string;
  updated: string;
  ageDays: number;
  inboundCount: number;
}
export interface ReadErrorFinding {
  path: string;
  error: string;
}

export interface LintSummary {
  totalPages: number;
  orphans: number;
  brokenLinks: number;
  oversizedHard: number;
  oversizedSoft: number;
  missingFrontmatter: number;
  malformedFrontmatter: number;
  duplicateSlugs: number;
  stalePages: number;
  readErrors: number;
}

export interface LintFindings {
  orphans: OrphanFinding[];
  brokenLinks: BrokenLinkFinding[];
  oversizedHard: OversizeFinding[];
  oversizedSoft: OversizeFinding[];
  missingFrontmatter: MissingFmFinding[];
  malformedFrontmatter: MalformedFmFinding[];
  duplicateSlugs: DuplicateSlugFinding[];
  stalePages: StaleFinding[];
  readErrors: ReadErrorFinding[];
  summary: LintSummary;
}

interface CollectedPage {
  path: string;
  relPath: string;
  slug: string;
  meta: Record<string, FrontmatterValue>;
  body: string;
  lineCount: number;
  links: string[];
  malformedFm: boolean;
  readError: string | null;
}

function listMarkdownFilesSorted(root: string): string[] {
  const out: string[] = [];
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
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && name.endsWith(".md")) {
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
  const last = parts[parts.length - 1];
  if (first === undefined) return true;
  if (parts.length === 1 && SKIP_TOP_LEVEL_FILES.has(first)) return true;
  if (SKIP_TOP_LEVEL_DIRS.has(first)) return true;
  if (last !== undefined && last.startsWith(".")) return true;
  return false;
}

function relPosix(root: string, full: string): string {
  return relative(root, full).split(sep).join("/");
}

function slugFromPath(full: string): string {
  const name = full.split(sep).pop() ?? "";
  return name.replace(/\.md$/, "");
}

function parseDate(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(m[1] + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}

function collectPages(root: string): CollectedPage[] {
  const files = listMarkdownFilesSorted(root);
  const pages: CollectedPage[] = [];
  for (const full of files) {
    const rel = relative(root, full);
    if (shouldSkip(rel)) continue;
    const relPath = relPosix(root, full);
    const slug = slugFromPath(full);

    let text: string;
    try {
      text = readFileSync(full, "utf-8");
    } catch (err) {
      pages.push({
        path: full,
        relPath,
        slug,
        meta: {},
        body: "",
        lineCount: 0,
        links: [],
        malformedFm: false,
        readError: (err as Error).message ?? String(err),
      });
      continue;
    }

    const { meta, body, malformed } = parseFrontmatter(text);
    const lineCount = (text.match(/\n/g)?.length ?? 0) + 1;
    pages.push({
      path: full,
      relPath,
      slug,
      meta,
      body,
      lineCount,
      links: extractWikilinks(body),
      malformedFm: malformed,
      readError: null,
    });
  }
  return pages;
}

function isMissingField(value: FrontmatterValue | undefined): boolean {
  if (value === undefined) return true;
  if (value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

export function lintWiki(root: string, opts: LintOptions = {}): LintFindings {
  const softCap = opts.softCap ?? DEFAULT_SOFT_CAP;
  const hardCap = opts.hardCap ?? DEFAULT_HARD_CAP;
  const requiredFm = opts.requiredFm ?? DEFAULT_REQUIRED_FM;
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const staleMinInbound = opts.staleMinInbound ?? DEFAULT_STALE_MIN_INBOUND;

  const allPages = collectPages(root);

  const findings: LintFindings = {
    orphans: [],
    brokenLinks: [],
    oversizedHard: [],
    oversizedSoft: [],
    missingFrontmatter: [],
    malformedFrontmatter: [],
    duplicateSlugs: [],
    stalePages: [],
    readErrors: [],
    summary: {
      totalPages: 0,
      orphans: 0,
      brokenLinks: 0,
      oversizedHard: 0,
      oversizedSoft: 0,
      missingFrontmatter: 0,
      malformedFrontmatter: 0,
      duplicateSlugs: 0,
      stalePages: 0,
      readErrors: 0,
    },
  };

  // Read errors split off the active set, matching Python.
  const pages: CollectedPage[] = [];
  for (const p of allPages) {
    if (p.readError !== null) {
      findings.readErrors.push({ path: p.relPath, error: p.readError });
    } else {
      pages.push(p);
    }
  }

  // Slug → paths (for duplicate detection).
  const slugPaths = new Map<string, string[]>();
  for (const p of pages) {
    const list = slugPaths.get(p.slug) ?? [];
    list.push(p.relPath);
    slugPaths.set(p.slug, list);
  }
  for (const [slug, paths] of slugPaths) {
    if (paths.length > 1) {
      findings.duplicateSlugs.push({ slug, paths });
    }
  }

  // Inbound link map.
  const inbound = new Map<string, Set<string>>();
  const allSlugs = new Set(slugPaths.keys());
  for (const p of pages) {
    for (const link of p.links) {
      const set = inbound.get(link) ?? new Set();
      set.add(p.slug);
      inbound.set(link, set);
    }
  }

  const today = new Date();

  for (const p of pages) {
    // Orphans
    const inboundForSlug = inbound.get(p.slug);
    if (!inboundForSlug || inboundForSlug.size === 0) {
      findings.orphans.push({ slug: p.slug, path: p.relPath });
    }

    // Broken links
    for (const link of p.links) {
      if (!allSlugs.has(link)) {
        findings.brokenLinks.push({
          from: p.slug,
          fromPath: p.relPath,
          to: link,
        });
      }
    }

    // Oversize (mutually exclusive)
    if (p.lineCount > hardCap) {
      findings.oversizedHard.push({ path: p.relPath, lines: p.lineCount });
    } else if (p.lineCount > softCap) {
      findings.oversizedSoft.push({ path: p.relPath, lines: p.lineCount });
    }

    // Frontmatter
    if (p.malformedFm) {
      findings.malformedFrontmatter.push({ path: p.relPath });
    } else {
      const missing = requiredFm.filter((f) => isMissingField(p.meta[f]));
      if (missing.length > 0) {
        findings.missingFrontmatter.push({ path: p.relPath, missing });
      }
    }

    // Staleness — well-linked but old.
    const updatedRaw = p.meta["updated"];
    const updatedDate = parseDate(updatedRaw);
    if (updatedDate) {
      const ageMs = today.getTime() - updatedDate.getTime();
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      const inboundCount = inboundForSlug?.size ?? 0;
      if (ageDays > staleDays && inboundCount >= staleMinInbound) {
        findings.stalePages.push({
          path: p.relPath,
          updated: typeof updatedRaw === "string" ? updatedRaw : "",
          ageDays,
          inboundCount,
        });
      }
    }
  }

  findings.summary = {
    totalPages: pages.length,
    orphans: findings.orphans.length,
    brokenLinks: findings.brokenLinks.length,
    oversizedHard: findings.oversizedHard.length,
    oversizedSoft: findings.oversizedSoft.length,
    missingFrontmatter: findings.missingFrontmatter.length,
    malformedFrontmatter: findings.malformedFrontmatter.length,
    duplicateSlugs: findings.duplicateSlugs.length,
    stalePages: findings.stalePages.length,
    readErrors: findings.readErrors.length,
  };

  return findings;
}
