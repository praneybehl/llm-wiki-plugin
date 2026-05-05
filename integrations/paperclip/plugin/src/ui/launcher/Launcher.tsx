import * as React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import { wikiHref, navigateTo } from "../href.js";
import { readRecent, RECENT_UPDATED_EVENT, type RecentEntry } from "../recent.js";

/**
 * Launcher — the sidebar surface. Job: get the user from anywhere in
 * Paperclip into the wiki workspace, fast. It does NOT read pages or
 * render markdown; that's the page slot's job (WikiPage).
 *
 * Sections:
 *   1. Header with an "Open" link to the wiki workspace.
 *   2. Search form — submits ?q=… to the workspace.
 *   3. Recent — last 8 pages from sessionStorage (recorded by Reader).
 *   4. Browse by type — counts per frontmatter `type`, links to #@type
 *      folder views.
 *   5. Health badge — pageCount + lint status, condensed.
 *
 * If the wiki is missing entirely, sections 3–5 are replaced by a
 * single CTA that routes to the Setup view.
 */

interface IndexPage {
  slug: string;
  title: string;
  type: string;
  relPath: string;
}

interface IndexPayload {
  index: string;
  shards: { name: string; text: string }[];
  pages: IndexPage[];
}

interface WikiHealth {
  pageCount: number;
  lintStatus: "pass" | "warn" | "fail";
  wikiPathMissing: boolean;
}

export interface LauncherProps {
  context: PluginHostContext;
}

export function Launcher({ context }: LauncherProps): React.ReactElement {
  const indexResult = usePluginData<IndexPayload>("loadIndex", {
    companyId: context.companyId,
    projectId: context.projectId,
  });
  const healthResult = usePluginData<WikiHealth>("wikiHealth", {
    companyId: context.companyId,
    projectId: context.projectId,
  });

  const [query, setQuery] = React.useState("");
  const [recent, setRecent] = React.useState<RecentEntry[]>(() => readRecent());

  // Subscribe to the custom event recordRecent() dispatches on every
  // write. Without this, the launcher and the page slot live in
  // different React trees inside Paperclip — the launcher's initial
  // recents would never refresh as the user navigates around the wiki.
  React.useEffect(() => {
    function refresh(): void {
      setRecent(readRecent());
    }
    refresh();
    window.addEventListener(RECENT_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(RECENT_UPDATED_EVENT, refresh);
  }, []);

  const onSubmit = React.useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        navigateTo(context.companyPrefix, { kind: "landing" });
        return;
      }
      navigateTo(context.companyPrefix, { kind: "search", query: trimmed });
    },
    [query, context.companyPrefix],
  );

  if (context.companyId === null) {
    return (
      <div className="llm-wiki-launcher">
        <p className="llm-wiki-empty">No Company is currently in scope.</p>
      </div>
    );
  }

  const wikiMissing = healthResult.data?.wikiPathMissing === true;
  const pages = indexResult.data?.pages ?? [];
  const typeCounts = countByType(pages);

  return (
    <div className="llm-wiki-launcher">
      <header className="llm-wiki-launcher-header">
        <span className="llm-wiki-launcher-title">LLM Wiki</span>
        <a
          href={wikiHref(context.companyPrefix, { kind: "landing" })}
          className="llm-wiki-launcher-open"
          data-testid="wiki-open"
        >
          Open ↗
        </a>
      </header>

      <form className="llm-wiki-launcher-search" onSubmit={onSubmit}>
        <input
          type="search"
          placeholder="Search the wiki…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="llm-wiki-search-input"
          aria-label="Search the wiki"
        />
      </form>

      {wikiMissing ? (
        <a
          href={wikiHref(context.companyPrefix, { kind: "setup" })}
          className="llm-wiki-launcher-setup-cta"
          data-testid="wiki-setup-cta"
        >
          Set up the wiki →
        </a>
      ) : (
        <>
          {recent.length > 0 ? (
            <section className="llm-wiki-launcher-section">
              <h3>Recent</h3>
              <ul className="llm-wiki-launcher-list">
                {recent.map((p) => (
                  <li key={p.slug}>
                    <a
                      href={wikiHref(context.companyPrefix, {
                        kind: "page",
                        slug: p.slug,
                      })}
                      data-wiki-slug={p.slug}
                    >
                      {p.title}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="llm-wiki-launcher-section">
            <h3>Browse</h3>
            <ul className="llm-wiki-launcher-list">
              {typeCounts.map(([type, count]) => (
                <li key={type}>
                  <a
                    href={wikiHref(context.companyPrefix, {
                      kind: "folder",
                      folder: type,
                    })}
                    data-testid={`wiki-browse-${type}`}
                  >
                    <span className="llm-wiki-launcher-type">{type}</span>
                    <span className="llm-wiki-launcher-count">{count}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>

          {healthResult.data ? (
            <footer className="llm-wiki-launcher-health">
              {healthResult.data.pageCount} pages ·{" "}
              <span
                className="llm-wiki-status-badge"
                data-lint-status={healthResult.data.lintStatus}
              >
                {healthResult.data.lintStatus}
              </span>
            </footer>
          ) : null}
        </>
      )}
    </div>
  );
}

function countByType(pages: IndexPage[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const p of pages) {
    counts.set(p.type, (counts.get(p.type) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}
