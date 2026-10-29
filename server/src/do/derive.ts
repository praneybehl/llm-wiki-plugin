/**
 * Derived data for one stored file, computed on write inside the commit
 * transaction: metadata columns, sections, links, stats fields, graph input.
 */

import { splitSections, type Section } from "../core/bm25";
import { extractWikilinks, parseFrontmatter, type FrontmatterValue } from "../core/frontmatter";
import { graphPageFromText, type GraphPage } from "../core/graph";
import { isSearchable, isTopLevelReadme, slugOf } from "../core/paths";
import { parseStatsType, statsLinks, wordCount } from "../core/stats";

export interface DerivedPage {
  searchable: boolean;
  slug: string;
  meta: Record<string, FrontmatterValue>;
  malformed: boolean;
  type: string | null;
  /** Raw frontmatter title (string) or null. */
  title: string | null;
  /** `meta.title or slug`, the title search rows and section text use. */
  displayTitle: string;
  tags: string[];
  sources: string[];
  updated: string | null;
  /** Valid YYYY-MM-DD prefix of `updated`, used by the `since` filter. */
  updatedDate: string | null;
  lineCount: number;
  wordCount: number;
  statsType: string | null;
  statsLinks: string[];
  /** Body wikilinks (search, lint, backlinks). */
  links: string[];
  /** Page body (frontmatter removed). */
  body: string;
  sections: Section[];
  /** Graph input, or null for files outside the graph scope. */
  graph: GraphPage | null;
}

/**
 * Bounds for text that derive copies out of the content into page and section
 * columns. Together with the 1.5 MB content limit they keep each SQLite row
 * under 2 MB. Normal pages never reach them.
 */
const FIELD_MAX_CHARS = 1000;
const LIST_MAX_JSON_CHARS = 16_000;

/** Cuts `value` to `max` UTF-16 units without splitting a surrogate pair. */
export function clip(value: string, max = FIELD_MAX_CHARS): string {
  if (value.length <= max) return value;
  const code = value.charCodeAt(max - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** Keeps leading items (each clipped) while the JSON array stays within LIST_MAX_JSON_CHARS. */
function boundList(items: string[]): string[] {
  const out: string[] = [];
  let size = 2;
  for (const item of items) {
    const kept = clip(item);
    size += JSON.stringify(kept).length + 1;
    if (size > LIST_MAX_JSON_CHARS) break;
    out.push(kept);
  }
  return out;
}

function asList(value: FrontmatterValue | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return value === "" ? [] : [value];
}

export function validDatePrefix(value: string | null | undefined): string | null {
  if (!value) return null;
  const prefix = value.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(prefix);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (date.getUTCMonth() !== Number(m[2]) - 1 || date.getUTCDate() !== Number(m[3])) return null;
  return prefix;
}

/** Python `text.count("\n") + 1`. */
export function lineCount(text: string): number {
  let count = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count++;
  return count;
}

export function derivePage(path: string, content: string): DerivedPage {
  const slug = slugOf(path);
  const isMarkdown = path.endsWith(".md");
  const searchable = isSearchable(path);
  const { meta, body, malformed } = isMarkdown ? parseFrontmatter(content) : { meta: {}, body: content, malformed: false };
  const rawTitle = meta.title;
  const title = typeof rawTitle === "string" ? clip(rawTitle) : null;
  const displayTitle = title || slug;
  const rawType = meta.type;
  const updated = typeof meta.updated === "string" ? clip(meta.updated) : null;
  const sections = searchable ? splitSections(displayTitle, body) : [];
  const statsType = isMarkdown ? parseStatsType(content) : null;
  for (const section of sections) section.headingPath = section.headingPath.map((heading) => clip(heading));
  return {
    searchable,
    slug,
    meta,
    malformed,
    type: typeof rawType === "string" ? clip(rawType) : null,
    title,
    displayTitle,
    tags: boundList(asList(meta.tags)),
    sources: boundList(asList(meta.sources)),
    updated,
    updatedDate: validDatePrefix(updated),
    lineCount: lineCount(content),
    wordCount: isMarkdown ? wordCount(content) : 0,
    statsType: statsType === null ? null : clip(statsType),
    statsLinks: isMarkdown ? statsLinks(content) : [],
    links: searchable ? extractWikilinks(body) : [],
    body,
    sections,
    graph: searchable && !isTopLevelReadme(path) ? graphPageFromText(path, slug, content) : null,
  };
}
