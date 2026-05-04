/**
 * Lightweight YAML-ish frontmatter parser.
 *
 * Byte-for-byte parity with the Python reference at
 * skills/llm-wiki/scripts/wiki_lint.py:46-73 (and wiki_search.py:43-69) for
 * the subset our schema actually uses. We deliberately do not pull a real
 * YAML library — search/lint output must match the reference exactly,
 * quirks included.
 *
 * Supported shapes:
 *   key: value
 *   key: "quoted value" | 'quoted value'
 *   key: [a, b, c]
 *   key:
 *     - item-1
 *     - item-2
 *
 * Key regex matches Python: ^[a-zA-Z_]+: — no hyphens, no digits in keys.
 * Lines that don't match are silently dropped, matching the reference.
 */

export type FrontmatterValue = string | string[];

export interface FrontmatterResult {
  meta: Record<string, FrontmatterValue>;
  body: string;
  malformed: boolean;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;
const KEY_VALUE_RE = /^([a-zA-Z_]+):\s*(.*)$/;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const TOKEN_RE = /[a-z0-9]+/g;

function stripOuterQuotes(value: string): string {
  // Match Python's chained .strip('"').strip("'") — strip " first, then '.
  // This is order-dependent, e.g. "'foo'" → 'foo' → foo.
  let s = value;
  while (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1);
  }
  while (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    s = s.slice(1, -1);
  }
  return s;
}

function parseInlineList(rawList: string): string[] {
  // rawList is the text between [ and ] (exclusive).
  return rawList
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map(stripOuterQuotes);
}

export function parseFrontmatter(text: string): FrontmatterResult {
  if (!text.startsWith("---")) {
    return { meta: {}, body: text, malformed: false };
  }
  const m = FRONTMATTER_RE.exec(text);
  if (!m) {
    return { meta: {}, body: text, malformed: true };
  }
  const fmText = m[1] ?? "";
  const body = text.slice(m[0].length);

  const meta: Record<string, FrontmatterValue> = {};
  let currentKey: string | null = null;

  for (const line of fmText.split("\n")) {
    if (line.trim() === "") continue;

    const kv = KEY_VALUE_RE.exec(line);
    if (kv) {
      const key = kv[1] as string;
      const rawValue = (kv[2] ?? "").trim();

      if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
        const inner = rawValue.slice(1, -1);
        meta[key] = parseInlineList(inner);
        currentKey = null;
      } else if (rawValue.length > 0) {
        meta[key] = stripOuterQuotes(rawValue);
        currentKey = null;
      } else {
        meta[key] = [];
        currentKey = key;
      }
    } else if (line.startsWith("  - ") && currentKey !== null) {
      const item = stripOuterQuotes(line.slice(4).trim());
      const list = meta[currentKey];
      if (Array.isArray(list)) {
        list.push(item);
      }
    }
    // Anything else (continuation line without an open key, malformed line):
    // silently dropped, matching Python.
  }

  return { meta, body, malformed: false };
}

export function extractWikilinks(body: string): string[] {
  const out: string[] = [];
  // /g flags require resetting lastIndex between calls when the regex is
  // module-level. Use a local exec loop on a fresh copy to be safe.
  const re = new RegExp(WIKILINK_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const slug = (match[1] ?? "").trim();
    out.push(slug);
  }
  return out;
}

export function tokenize(text: string): string[] {
  const re = new RegExp(TOKEN_RE.source, "g");
  return text.toLowerCase().match(re) ?? [];
}
