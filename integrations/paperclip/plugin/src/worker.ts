/**
 * paperclip-plugin-llm-wiki worker.
 *
 * Source contract:
 *   - definePlugin / runWorker:        @paperclipai/plugin-sdk/worker-rpc-host
 *   - PluginContext:                   @paperclipai/plugin-sdk/types
 *   - Filesystem pattern (verbatim):   plugin-file-browser-example
 *     (FEASIBILITY.md §1) — workers read the wiki directly with node:fs after
 *     resolving the workspace cwd through ctx.projects.getPrimaryWorkspace.
 *
 * Read-only by contract (SPEC §Non-goals). The worker registers data
 * providers + one agent-callable tool; it does NOT register any actions
 * and never writes to disk.
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  PluginContext,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseFrontmatter,
  extractWikilinks,
  type FrontmatterValue,
} from "./lib/frontmatter.js";
import { collectPages, searchPages } from "./lib/bm25.js";
import { lintWiki, type LintFindings } from "./lib/lint.js";
import { computeStats } from "./lib/stats.js";

interface PluginConfig {
  wiki_path?: string;
  lint_check_interval_minutes?: number;
  search_top_k?: number;
}

interface SearchFiltersInput {
  type?: string;
  tags?: string[];
  since?: string;
}

interface PageRefResult {
  slug: string;
  title: string;
  type: string;
  score?: number;
  relPath?: string;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function metaString(meta: Record<string, FrontmatterValue>, key: string): string {
  const v = meta[key];
  return typeof v === "string" ? v : "";
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isInside(parent: string, target: string): boolean {
  const rel = path.relative(parent, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function getConfig(ctx: PluginContext): Promise<PluginConfig> {
  try {
    return (await ctx.config.get()) as PluginConfig;
  } catch {
    return {};
  }
}

const TOPK_MIN = 1;
const TOPK_MAX = 20;
const TOPK_DEFAULT = 5;

function isValidTopK(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isFinite(n) &&
    n >= TOPK_MIN &&
    n <= TOPK_MAX
  );
}

/**
 * Resolve the topK value with precedence: explicit param > config > default.
 *
 * The manifest's instanceConfigSchema gates search_top_k to the [1, 20]
 * range with a default of 5. Out-of-range values from either source fall
 * through to the next candidate so the schema bounds are always
 * respected, matching what the host's auto-form would enforce on input.
 */
async function resolveTopK(
  ctx: PluginContext,
  paramTopK: unknown,
): Promise<number> {
  const fromParam = typeof paramTopK === "string" ? Number(paramTopK) : paramTopK;
  if (isValidTopK(fromParam)) return Math.floor(fromParam);
  const config = await getConfig(ctx);
  if (isValidTopK(config.search_top_k)) return Math.floor(config.search_top_k);
  return TOPK_DEFAULT;
}

const LINT_INTERVAL_MIN_MINUTES = 5;
const LINT_INTERVAL_DEFAULT_MINUTES = 60;

/**
 * Resolve the dashboard widget's refresh interval (in minutes) from the
 * operator's config, with fallback to the schema default and clamping to
 * the schema's `minimum: 5`.
 */
async function resolveLintIntervalMinutes(ctx: PluginContext): Promise<number> {
  const config = await getConfig(ctx);
  const raw = config.lint_check_interval_minutes;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return LINT_INTERVAL_DEFAULT_MINUTES;
  }
  const floored = Math.floor(raw);
  return floored < LINT_INTERVAL_MIN_MINUTES
    ? LINT_INTERVAL_MIN_MINUTES
    : floored;
}

/**
 * Resolve the wiki root for a Company. Per SPEC §"Multi-Company behavior", v0.1
 * assumes one wiki per Company, located under the Company's primary
 * workspace at the configured `wiki_path` (default "wiki"). When projectId is
 * not in scope (Company-level slot context), the first project in the
 * Company is used as a stand-in.
 *
 * Returns the absolute path on success, or null if the wiki can't be
 * located (capability declined, no project, no workspace, missing dir, or
 * containment check fails). The worker's data handlers convert null to a
 * graceful `{ error: ... }` response — they never throw to the host.
 */
/**
 * Test whether the wiki resolves at a given workspace.
 *
 * Real Paperclip's ctx.projects.getPrimaryWorkspace synthesizes a workspace
 * for every project — it falls back to project.codebase.effectiveLocalFolder
 * even when no explicit workspace row exists (see plugin-host-services.ts).
 * So the company-level fallback in resolveWikiRoot can't stop on the first
 * non-null workspace; it has to find the project whose workspace actually
 * contains the configured wiki directory.
 */
function resolveWikiAt(
  workspacePath: string,
  wikiPath: string,
): string | null {
  const root = path.resolve(workspacePath, wikiPath);
  if (!isInside(workspacePath, root)) return null;
  if (!fs.existsSync(root)) return null;
  return resolvedContainedRoot(workspacePath, root);
}

async function resolveWikiRoot(
  ctx: PluginContext,
  companyId: string,
  projectId: string | null,
): Promise<string | null> {
  if (!companyId) return null;
  const config = await getConfig(ctx);
  const wikiPath = isString(config.wiki_path) && config.wiki_path.length > 0
    ? config.wiki_path
    : "wiki";

  try {
    // Try the explicit project first if provided.
    if (projectId) {
      const ws = await ctx.projects.getPrimaryWorkspace(projectId, companyId);
      if (ws) {
        const resolved = resolveWikiAt(ws.path, wikiPath);
        if (resolved !== null) return resolved;
        // Explicit projectId was given but the wiki isn't there — don't
        // silently search other projects, return null. The slot context
        // pointed somewhere specific; honoring that intent matters.
        return null;
      }
    }

    // Company-level fallback: walk every project, accept only the one
    // whose workspace actually contains the wiki. Stopping on the first
    // non-null workspace would pick projects that synthesize a
    // workspace via effectiveLocalFolder but don't actually have the
    // wiki (real Paperclip behavior).
    const projects = await ctx.projects.list({ companyId, limit: 50 });
    for (const project of projects) {
      const ws = await ctx.projects.getPrimaryWorkspace(project.id, companyId);
      if (!ws) continue;
      const resolved = resolveWikiAt(ws.path, wikiPath);
      if (resolved !== null) return resolved;
    }
  } catch {
    return null;
  }

  return null;
}

async function resolveWikiRootForIssue(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
): Promise<string | null> {
  const config = await getConfig(ctx);
  const wikiPath = isString(config.wiki_path) && config.wiki_path.length > 0
    ? config.wiki_path
    : "wiki";
  let ws = null;
  try {
    ws = await ctx.projects.getWorkspaceForIssue(issueId, companyId);
  } catch {
    return null;
  }
  if (!ws) return null;
  return resolveWikiAt(ws.path, wikiPath);
}

/**
 * Final containment gate for the wiki root: the lexical path.relative()
 * check above only catches `..` escapes in `wiki_path`, not symlinks.
 * If the wiki directory itself is a symlink that points outside the
 * workspace (e.g. `wiki` → `/etc`), every realpathContained() call
 * downstream would happily anchor on the escape destination. Resolve
 * both ends here and reject if the wiki root's realpath isn't under
 * the workspace's realpath. Returns the resolved realpath on success
 * so all subsequent walkers anchor on the canonical path.
 */
function resolvedContainedRoot(
  workspaceRoot: string,
  wikiRoot: string,
): string | null {
  let realWorkspace: string;
  let realRoot: string;
  try {
    realWorkspace = fs.realpathSync(workspaceRoot);
    realRoot = fs.realpathSync(wikiRoot);
  } catch {
    return null;
  }
  if (realRoot === realWorkspace) return realRoot;
  if (!realRoot.startsWith(realWorkspace + path.sep)) return null;
  return realRoot;
}

/**
 * Returns true if `target`'s realpath stays under `realRoot`.
 *
 * Defense beyond the path.relative() containment check: a symlink under
 * the wiki could point to anywhere on disk and Node's statSync would
 * follow it transparently. We lstat first, then realpath, and reject
 * anything whose real location escapes the wiki root.
 */
function realpathContained(realRoot: string, target: string): string | null {
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    return null;
  }
  if (realTarget === realRoot) return realTarget;
  if (!realTarget.startsWith(realRoot + path.sep)) return null;
  return realTarget;
}

function resolvePageFile(root: string, slug: string): string | null {
  // Try direct match first, then a recursive walk (slugs aren't path-prefixed
  // in our data model — every page is unique by basename).
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }

  const candidates: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let lst;
      try {
        lst = fs.lstatSync(full);
      } catch {
        continue;
      }
      const isSymlink = lst.isSymbolicLink();
      if (realpathContained(realRoot, full) === null) continue;

      let isDir: boolean;
      let isFile: boolean;
      if (isSymlink) {
        try {
          const stat = fs.lstatSync(fs.realpathSync(full));
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      } else {
        isDir = lst.isDirectory();
        isFile = lst.isFile();
      }

      if (isDir) walk(full);
      else if (isFile && name === `${slug}.md`) candidates.push(full);
    }
  }
  walk(root);

  // Defense in depth: re-check each candidate with realpathContained
  // (already passed above, but cheap to re-verify before opening the file).
  for (const c of candidates) {
    if (realpathContained(realRoot, c) !== null) return c;
  }
  return null;
}

const plugin = definePlugin({
  async setup(ctx) {
    // ── readPage ──────────────────────────────────────────────────────
    ctx.data.register("readPage", async (params) => {
      const companyId = String(params.companyId ?? "");
      const projectId = params.projectId ? String(params.projectId) : null;
      const slug = String(params.slug ?? "");
      // Short-circuit before any host RPC or filesystem access. The UI
      // unconditionally invokes readPage with slug: "" when nothing is
      // selected; without this, every sidebar mount runs a full walk.
      if (slug.trim().length === 0) {
        return { error: "no slug provided" };
      }
      const root = await resolveWikiRoot(ctx, companyId, projectId);
      if (!root) {
        return { error: "wiki path not accessible" };
      }
      const file = resolvePageFile(root, slug);
      if (!file) {
        return { error: `page not found: ${slug}` };
      }
      let text: string;
      try {
        text = fs.readFileSync(file, "utf-8");
      } catch (err) {
        return { error: `read failed: ${(err as Error).message}` };
      }
      const { meta, body } = parseFrontmatter(text);
      const links = extractWikilinks(body);
      return { slug, meta, body, links };
    });

    // ── searchWiki ────────────────────────────────────────────────────
    ctx.data.register("searchWiki", async (params) => {
      const companyId = String(params.companyId ?? "");
      const projectId = params.projectId ? String(params.projectId) : null;
      const query = String(params.query ?? "");
      // Short-circuit before any host RPC or filesystem access. The UI
      // calls searchWiki on every keystroke (including empty); without
      // this, an empty search box runs a full collectPages walk that
      // produces nothing useful.
      if (query.trim().length === 0) {
        return { results: [] };
      }
      const topK = await resolveTopK(ctx, params.topK);
      const filters = (params.filters ?? {}) as SearchFiltersInput;
      const root = await resolveWikiRoot(ctx, companyId, projectId);
      if (!root) return { results: [] };
      const pages = collectPages(root);
      const scored = searchPages(pages, { query, topK, filters });
      const results: PageRefResult[] = scored.map(({ score, page }) => ({
        slug: page.slug,
        title: metaString(page.meta, "title") || page.slug,
        type: metaString(page.meta, "type") || "(none)",
        score,
      }));
      return { results };
    });

    // ── loadIndex ─────────────────────────────────────────────────────
    ctx.data.register("loadIndex", async (params) => {
      const companyId = String(params.companyId ?? "");
      const projectId = params.projectId ? String(params.projectId) : null;
      const root = await resolveWikiRoot(ctx, companyId, projectId);
      if (!root) return { index: "", shards: [], pages: [] };

      // Direct reads for index.md and indexes/*.md must go through the
      // realpath containment check too — collectPages only protects the
      // page tree. A symlinked wiki/index.md that points outside the
      // wiki would otherwise leak its target.
      let index = "";
      const indexFull = path.join(root, "index.md");
      if (realpathContained(root, indexFull) !== null) {
        try {
          index = fs.readFileSync(indexFull, "utf-8");
        } catch {
          // index.md is optional
        }
      }

      const shards: { name: string; text: string }[] = [];
      const shardDir = path.join(root, "indexes");
      // realpathContained also rejects when the shard directory itself is
      // a symlink that points outside the wiki.
      if (
        isInside(root, shardDir) &&
        realpathContained(root, shardDir) !== null
      ) {
        try {
          for (const name of fs.readdirSync(shardDir).sort()) {
            if (!name.endsWith(".md")) continue;
            const full = path.join(shardDir, name);
            if (realpathContained(root, full) === null) continue;
            try {
              shards.push({
                name: name.replace(/\.md$/, ""),
                text: fs.readFileSync(full, "utf-8"),
              });
            } catch {
              // skip unreadable shard
            }
          }
        } catch {
          // shard dir is optional
        }
      }

      const pages: PageRefResult[] = collectPages(root).map((p) => ({
        slug: p.slug,
        title: metaString(p.meta, "title") || p.slug,
        type: metaString(p.meta, "type") || "(none)",
        relPath: p.relPath,
      }));

      return { index, shards, pages };
    });

    // ── lintWiki ──────────────────────────────────────────────────────
    ctx.data.register("lintWiki", async (params) => {
      const companyId = String(params.companyId ?? "");
      const projectId = params.projectId ? String(params.projectId) : null;
      const root = await resolveWikiRoot(ctx, companyId, projectId);
      if (!root) {
        const empty: LintFindings = {
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
        return empty;
      }
      return lintWiki(root);
    });

    // ── wikiHealth ────────────────────────────────────────────────────
    ctx.data.register("wikiHealth", async (params) => {
      const companyId = String(params.companyId ?? "");
      const projectId = params.projectId ? String(params.projectId) : null;
      const lintCheckIntervalMinutes = await resolveLintIntervalMinutes(ctx);
      const root = await resolveWikiRoot(ctx, companyId, projectId);
      if (!root) {
        return {
          pageCount: 0,
          indexLines: 0,
          linkDensity: 0,
          scalingMessages: [],
          lintStatus: "warn" as const,
          lintFindings: null,
          wikiPathMissing: true,
          lintCheckIntervalMinutes,
        };
      }
      const stats = computeStats(root);
      const lint = lintWiki(root);
      // Categorize: hard-fail conditions block, soft conditions warn.
      const failure =
        lint.summary.oversizedHard > 0 ||
        lint.summary.malformedFrontmatter > 0 ||
        lint.summary.duplicateSlugs > 0;
      const warn =
        lint.summary.brokenLinks > 0 ||
        lint.summary.orphans > 0 ||
        lint.summary.missingFrontmatter > 0 ||
        lint.summary.oversizedSoft > 0 ||
        lint.summary.stalePages > 0;
      const lintStatus: "pass" | "warn" | "fail" = failure
        ? "fail"
        : warn
          ? "warn"
          : "pass";
      return {
        pageCount: stats.totalPages,
        indexLines: stats.indexLines,
        linkDensity: stats.linkDensity,
        scalingMessages: stats.scalingMessages,
        lintStatus,
        lintFindings: lint.summary,
        wikiPathMissing: false,
        lintCheckIntervalMinutes,
      };
    });

    // ── backlinks ─────────────────────────────────────────────────────
    ctx.data.register("backlinks", async (params) => {
      const companyId = String(params.companyId ?? "");
      const projectId = params.projectId ? String(params.projectId) : null;
      const slug = String(params.slug ?? "").trim();
      if (slug.length === 0) return { results: [] };

      const root = await resolveWikiRoot(ctx, companyId, projectId);
      if (!root) return { results: [] };

      const pages = collectPages(root);
      // Pages whose body contains a wikilink to `slug` (either bare
      // [[slug]] or aliased [[slug|display]]). extractWikilinks already
      // canonicalises both forms to the slug. We exclude the page itself
      // so a page never appears in its own backlinks.
      const results = pages
        .filter((p) => p.slug !== slug && p.links.includes(slug))
        .map((p) => {
          const title = metaString(p.meta, "title") || p.slug;
          const type = metaString(p.meta, "type") || "(none)";
          // Snippet — first line containing the wikilink (with optional
          // alias). Falls back to the page's first non-empty paragraph.
          const re = new RegExp(`\\[\\[${escapeForRegex(slug)}(?:\\|[^\\]]+)?\\]\\]`);
          const lines = p.body.split(/\r?\n/);
          const hit = lines.find((line) => re.test(line));
          const snippet = (hit ?? lines.find((l) => l.trim().length > 0) ?? "").trim();
          return { slug: p.slug, title, type, snippet };
        });
      return { results };
    });

    // ── relevantForIssue ──────────────────────────────────────────────
    ctx.data.register("relevantForIssue", async (params) => {
      const companyId = String(params.companyId ?? "");
      const issueId = String(params.issueId ?? "");
      const topK = await resolveTopK(ctx, params.topK);

      let issue = null;
      try {
        issue = await ctx.issues.get(issueId, companyId);
      } catch {
        return { results: [] };
      }
      if (!issue) return { results: [] };

      let root = await resolveWikiRootForIssue(ctx, companyId, issueId);
      if (!root) {
        root = await resolveWikiRoot(ctx, companyId, issue.projectId ?? null);
      }
      if (!root) return { results: [] };

      const queryText = `${issue.title ?? ""} ${issue.description ?? ""}`.trim();
      if (queryText.length === 0) return { results: [] };

      const pages = collectPages(root);
      const scored = searchPages(pages, { query: queryText, topK });
      const results: PageRefResult[] = scored.map(({ score, page }) => ({
        slug: page.slug,
        title: metaString(page.meta, "title") || page.slug,
        type: metaString(page.meta, "type") || "(none)",
        score,
      }));
      return { results };
    });

    // ── wiki.query agent tool ────────────────────────────────────────
    ctx.tools.register(
      "wiki.query",
      {
        displayName: "Query the LLM Wiki",
        description:
          "BM25 search over the active Company's wiki. Returns top N pages with one-line summaries.",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            topK: { type: "number", default: 5 },
            type: { type: "string" },
            tag: { type: "string" },
          },
          required: ["query"],
        },
      },
      async (rawParams: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const params = (rawParams ?? {}) as {
          query?: string;
          topK?: number;
          type?: string;
          tag?: string;
        };
        const query = String(params.query ?? "");
        const topK = await resolveTopK(ctx, params.topK);
        const filters: SearchFiltersInput = {};
        if (params.type) filters.type = params.type;
        if (params.tag) filters.tags = [params.tag];

        const root = await resolveWikiRoot(
          ctx,
          runCtx.companyId,
          runCtx.projectId,
        );
        if (!root) {
          return {
            content: "Wiki not configured for this Company.",
            error: "wiki path not accessible",
          };
        }
        const pages = collectPages(root);
        const scored = searchPages(pages, { query, topK, filters });
        const results: PageRefResult[] = scored.map(({ score, page }) => ({
          slug: page.slug,
          title: metaString(page.meta, "title") || page.slug,
          type: metaString(page.meta, "type") || "(none)",
          score,
        }));

        if (results.length === 0) {
          return {
            content: `No wiki pages matched ${JSON.stringify(query)}.`,
            data: { results: [] },
          };
        }

        const lines = [
          `Top ${results.length} wiki pages for ${JSON.stringify(query)}:`,
          "",
          ...results.map(
            (r) => `- [[${r.slug}]] (${r.type}) — ${r.title}`,
          ),
        ];
        return {
          content: lines.join("\n"),
          data: { results },
        };
      },
    );
  },

  async onHealth() {
    // Liveness probe — a missing wiki shouldn't fail the worker process
    // itself. Wiki configuration health surfaces via the wikiHealth data
    // provider instead.
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
