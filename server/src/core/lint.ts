/**
 * Structural lint. Port of `lint` in skills/llm-wiki/scripts/wiki_lint.py
 * over in-memory page records (same finding categories, fields, summary).
 *
 * Defaults match the Python CLI: soft cap 400 lines, hard cap 800 lines,
 * required frontmatter type,title,tags,created,updated, stale after 90 days
 * for pages with at least 3 inbound links. `--suggest-pages` is not ported
 * (it is off by default in Python), so `suggested_pages` is always empty.
 */

import type { FrontmatterValue } from "./frontmatter";
import { buildLinkIndex, resolveLink } from "./links";

export interface LintPage {
  path: string;
  slug: string;
  meta: Record<string, FrontmatterValue>;
  malformed: boolean;
  lineCount: number;
  links: string[];
}

export interface LintOptions {
  softCap?: number;
  hardCap?: number;
  requiredFm?: string[];
  staleDays?: number;
  /** Today as YYYY-MM-DD (UTC); tests pin it. */
  today?: string;
}

export interface LintFindings {
  orphans: { slug: string; path: string }[];
  broken_links: { from: string; from_path: string; to: string }[];
  oversized_hard: { path: string; lines: number }[];
  oversized_soft: { path: string; lines: number }[];
  missing_frontmatter: { path: string; missing: string[] }[];
  malformed_frontmatter: { path: string }[];
  duplicate_slugs: { slug: string; paths: string[] }[];
  stale_pages: { path: string; updated: FrontmatterValue | undefined; age_days: number; inbound_count: number }[];
  read_errors: { path: string; error: string }[];
  suggested_pages: { phrase: string; page_count: number; pages: string[] }[];
  summary: Record<string, number>;
}

const DEFAULT_REQUIRED = ["type", "title", "tags", "created", "updated"];
const DAY_MS = 86_400_000;

function parseDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.slice(0, 10));
  if (!m || value.slice(0, 10).length !== 10) return null;
  const time = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const check = new Date(time);
  if (check.getUTCMonth() !== Number(m[2]) - 1 || check.getUTCDate() !== Number(m[3])) return null;
  return time;
}

function isEmpty(value: FrontmatterValue | undefined): boolean {
  return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

/** `pages` in path order. */
export function lintPages(pages: LintPage[], opts: LintOptions = {}): LintFindings {
  const softCap = opts.softCap ?? 400;
  const hardCap = opts.hardCap ?? 800;
  const required = opts.requiredFm ?? DEFAULT_REQUIRED;
  const staleDays = opts.staleDays ?? 90;
  const today = parseDate(opts.today ?? new Date().toISOString().slice(0, 10)) ?? Date.now();

  const findings: LintFindings = {
    orphans: [],
    broken_links: [],
    oversized_hard: [],
    oversized_soft: [],
    missing_frontmatter: [],
    malformed_frontmatter: [],
    duplicate_slugs: [],
    stale_pages: [],
    read_errors: [],
    suggested_pages: [],
    summary: {},
  };

  const slugToPages = new Map<string, string[]>();
  for (const page of pages) {
    const list = slugToPages.get(page.slug) ?? [];
    list.push(page.path);
    slugToPages.set(page.slug, list);
  }
  for (const [slug, paths] of slugToPages) {
    if (paths.length > 1) findings.duplicate_slugs.push({ slug, paths });
  }

  const index = buildLinkIndex(pages);
  const inbound = new Map<string, Set<string>>();
  for (const page of pages) {
    for (const link of page.links) {
      const resolved = resolveLink(link, index);
      if (!resolved) continue;
      const set = inbound.get(resolved) ?? new Set<string>();
      set.add(page.slug);
      inbound.set(resolved, set);
    }
  }

  for (const page of pages) {
    const inboundCount = inbound.get(page.slug)?.size ?? 0;
    if (inboundCount === 0) findings.orphans.push({ slug: page.slug, path: page.path });

    for (const link of page.links) {
      if (resolveLink(link, index) === null) {
        findings.broken_links.push({ from: page.slug, from_path: page.path, to: link });
      }
    }

    if (page.lineCount > hardCap) findings.oversized_hard.push({ path: page.path, lines: page.lineCount });
    else if (page.lineCount > softCap) findings.oversized_soft.push({ path: page.path, lines: page.lineCount });

    if (page.malformed) {
      findings.malformed_frontmatter.push({ path: page.path });
    } else {
      const missing = required.filter((field) => isEmpty(page.meta[field]));
      if (missing.length > 0) findings.missing_frontmatter.push({ path: page.path, missing });
    }

    const updated = parseDate(page.meta.updated);
    if (updated !== null) {
      const ageDays = Math.floor((today - updated) / DAY_MS);
      if (ageDays > staleDays && inboundCount >= 3) {
        findings.stale_pages.push({
          path: page.path,
          updated: page.meta.updated,
          age_days: ageDays,
          inbound_count: inboundCount,
        });
      }
    }
  }

  findings.summary = {
    total_pages: pages.length,
    orphans: findings.orphans.length,
    broken_links: findings.broken_links.length,
    oversized_hard: findings.oversized_hard.length,
    oversized_soft: findings.oversized_soft.length,
    missing_frontmatter: findings.missing_frontmatter.length,
    malformed_frontmatter: findings.malformed_frontmatter.length,
    duplicate_slugs: findings.duplicate_slugs.length,
    stale_pages: findings.stale_pages.length,
    read_errors: findings.read_errors.length,
    suggested_pages: findings.suggested_pages.length,
  };
  return findings;
}
