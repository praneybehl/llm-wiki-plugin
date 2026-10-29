/**
 * Path rules and search exclusions for wiki files stored in a WikiDO.
 *
 * Exclusions match the local Python scripts: top-level SCHEMA.md, index.md,
 * log.md; top-level dirs indexes/, graph/, raw/, .wiki-cache/, .evolution/;
 * dotfiles; non-.md files.
 */

export const MAX_PATH_BYTES = 512;
export const MAX_FILE_BYTES = 1_500_000;
export const MAX_COMMIT_OPS = 200;
export const MAX_COMMIT_BYTES = 4_000_000;

const TEMPLATE_DOTFILE_RE = /^\.[a-z0-9-]+-template\.(md|json)$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const SKIP_TOP_LEVEL_FILES = new Set(["SCHEMA.md", "index.md", "log.md"]);
const SKIP_TOP_LEVEL_DIRS = new Set(["indexes", "graph", "raw", ".wiki-cache", ".evolution"]);

export const ONTOLOGY_PATH = "graph/ontology.yaml";
export const LOG_PATH = "log.md";

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Returns an error message when `path` breaks a path rule, else null. */
export function pathError(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "path must be a non-empty string";
  if (byteLength(path) > MAX_PATH_BYTES) return `path is longer than ${MAX_PATH_BYTES} bytes`;
  if (path.includes("\\")) return "path must not contain a backslash";
  if (CONTROL_RE.test(path)) return "path must not contain control characters";
  if (path.startsWith("/")) return "path must be relative (no leading /)";
  const segments = path.split("/");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === "") return "path must not contain empty segments";
    if (segment === "." || segment === "..") return "path must not contain . or .. segments";
    if (segment.startsWith(".")) {
      const allowed = segments.length === 1 && TEMPLATE_DOTFILE_RE.test(segment);
      if (!allowed) return "path segments must not start with a dot";
    }
  }
  return null;
}

/** Lone surrogates mean the text cannot round-trip as UTF-8. */
export function isWellFormedText(text: string): boolean {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
}

/** True when a page takes part in search, lint, stats and graph. */
export function isSearchable(path: string): boolean {
  if (!path.endsWith(".md")) return false;
  const parts = path.split("/");
  const first = parts[0] ?? "";
  if (parts.length === 1 && SKIP_TOP_LEVEL_FILES.has(first)) return false;
  if (parts.length > 1 && SKIP_TOP_LEVEL_DIRS.has(first)) return false;
  if ((parts[parts.length - 1] ?? "").startsWith(".")) return false;
  return true;
}

/** Filename stem: the page identity used by wikilinks. */
export function slugOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Top-level README.md is skipped by wiki_lint.py, wiki_stats.py and the graph scripts. */
export function isTopLevelReadme(path: string): boolean {
  return path === "README.md";
}
