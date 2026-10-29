/**
 * Lightweight YAML-ish frontmatter parser.
 *
 * Parity with `parse_frontmatter` in skills/llm-wiki/scripts/wiki_lint.py and
 * wiki_search.py for the subset the schema uses. It does not use a YAML
 * library on purpose: search and lint output must match the reference,
 * quirks included. The graph layer parses frontmatter with `yaml` instead
 * (see graph.ts), like the Python graph scripts.
 *
 * Supported shapes:
 *   key: value
 *   key: "quoted value" | 'quoted value'
 *   key: [a, b, c]
 *   key:
 *     - item-1
 *     - item-2
 *
 * Key regex matches Python: ^[a-zA-Z_]+: (no hyphens, no digits in keys).
 * Lines that do not match are dropped, like the reference.
 */

export type FrontmatterValue = string | string[];

export interface FrontmatterResult {
  meta: Record<string, FrontmatterValue>;
  body: string;
  malformed: boolean;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;
// Python `.` matches every character except "\n" (JS `.` also skips "\r").
const KEY_VALUE_RE = /^([a-zA-Z_]+):\s*([^\n]*)$/;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const TOKEN_RE = /[a-z0-9]+/g;

/** Python `str.strip(ch)` for one character. */
function pyStrip(value: string, ch: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ch) start++;
  while (end > start && value[end - 1] === ch) end--;
  return value.slice(start, end);
}

function stripOuterQuotes(value: string): string {
  // Python: value.strip('"').strip("'").
  return pyStrip(pyStrip(value, '"'), "'");
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
      } else if (rawValue.length > 0) {
        meta[key] = stripOuterQuotes(rawValue);
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
    // Anything else (continuation line without an open key, malformed line)
    // is dropped, like Python. Python also keeps `current_key` open after a
    // later scalar key, so this parser does too.
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
