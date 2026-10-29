/**
 * Wikilink resolution. Port of `clean_link_target`, `resolve_link` and
 * `link_key` in skills/llm-wiki/scripts/wiki_search.py (wiki_lint.py and
 * wiki_graph_extract.py use the same rules).
 *
 * Bare links ([[kalman-filter]]) name a page by filename stem. A directory
 * prefix ([[entities/kalman-filter]]) is a constraint: the link resolves only
 * when that exact path exists. Matching is case-sensitive.
 */

/** Strip a wikilink down to its path, dropping alias, anchor, and .md. */
export function cleanLinkTarget(link: string): string {
  let target = link.split("|", 1)[0] ?? "";
  target = target.split("#", 1)[0] ?? "";
  target = pyStripSlashes(target.replaceAll("\\", "/").trim());
  if (target.toLowerCase().endsWith(".md")) target = target.slice(0, -3);
  return target.trim();
}

function pyStripSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") start++;
  while (end > start && value[end - 1] === "/") end--;
  return value.slice(start, end);
}

export interface LinkIndex {
  /** Wiki-relative path without `.md` -> slug. */
  byPath: Map<string, string>;
  bySlug: Set<string>;
}

export function buildLinkIndex(pages: { path: string; slug: string }[]): LinkIndex {
  const byPath = new Map<string, string>();
  for (const page of pages) {
    let rel = page.path.replaceAll("\\", "/");
    if (rel.toLowerCase().endsWith(".md")) rel = rel.slice(0, -3);
    byPath.set(rel, page.slug);
  }
  return { byPath, bySlug: new Set(pages.map((page) => page.slug)) };
}

export function resolveLink(link: string, index: LinkIndex): string | null {
  const target = cleanLinkTarget(link);
  if (!target) return null;
  if (target.includes("/")) return index.byPath.get(target) ?? null;
  return index.bySlug.has(target) ? target : null;
}

/** Canonical key for reports, preserving unresolved targets. */
export function linkKey(link: string, index: LinkIndex): string {
  return resolveLink(link, index) ?? cleanLinkTarget(link);
}
