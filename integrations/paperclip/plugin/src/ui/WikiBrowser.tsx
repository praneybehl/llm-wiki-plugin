import * as React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import { WikiPageView, type WikiPageData } from "./WikiPageView.js";

/**
 * Shared "browser" surface used by both WikiSidebar (small) and WikiPage
 * (full-width). Keeps a current-slug state so clicking a result drills
 * into the page view without leaving the slot.
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

interface SearchResult {
  slug: string;
  title: string;
  type: string;
  score: number;
}

interface SearchPayload {
  results: SearchResult[];
}

export interface WikiBrowserProps {
  context: PluginHostContext;
  className?: string;
}

export function WikiBrowser({
  context,
  className,
}: WikiBrowserProps): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const [currentSlug, setCurrentSlug] = React.useState<string | null>(null);

  const indexResult = usePluginData<IndexPayload>("loadIndex", {
    companyId: context.companyId,
    projectId: context.projectId,
  });

  const trimmedQuery = query.trim();
  const searchResult = usePluginData<SearchPayload>("searchWiki", {
    companyId: context.companyId,
    projectId: context.projectId,
    query: trimmedQuery,
    topK: 10,
  });

  const pageResult = usePluginData<WikiPageData & { error?: string }>(
    "readPage",
    {
      companyId: context.companyId,
      projectId: context.projectId,
      slug: currentSlug ?? "",
    },
  );

  const wrapperClass = ["llm-wiki-browser", className]
    .filter(Boolean)
    .join(" ");

  if (context.companyId === null) {
    return (
      <div className={wrapperClass}>
        <p>No Company is currently in scope.</p>
      </div>
    );
  }

  if (indexResult.error !== null) {
    return (
      <div className={wrapperClass} data-state="error">
        <p>Error: {indexResult.error.message}</p>
      </div>
    );
  }

  return (
    <div className={wrapperClass}>
      <header className="llm-wiki-browser-header">
        <input
          type="search"
          placeholder="Search the wiki…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCurrentSlug(null);
          }}
          className="llm-wiki-search-input"
        />
        {currentSlug !== null ? (
          <button
            type="button"
            className="llm-wiki-back"
            onClick={() => setCurrentSlug(null)}
          >
            ← Back
          </button>
        ) : null}
      </header>

      {currentSlug !== null ? (
        <PageDetail
          loading={pageResult.loading}
          error={pageResult.error?.message ?? null}
          page={
            pageResult.data && !pageResult.data.error
              ? (pageResult.data as WikiPageData)
              : null
          }
          onWikilinkClick={(slug) => setCurrentSlug(slug)}
        />
      ) : trimmedQuery.length > 0 ? (
        <SearchResults
          loading={searchResult.loading}
          results={searchResult.data?.results ?? []}
          onSelect={(slug) => setCurrentSlug(slug)}
        />
      ) : (
        <PageList
          loading={indexResult.loading}
          pages={indexResult.data?.pages ?? []}
          onSelect={(slug) => setCurrentSlug(slug)}
        />
      )}
    </div>
  );
}

function PageList({
  loading,
  pages,
  onSelect,
}: {
  loading: boolean;
  pages: IndexPage[];
  onSelect: (slug: string) => void;
}): React.ReactElement {
  if (loading && pages.length === 0) return <p>Loading…</p>;
  if (pages.length === 0) {
    return <p className="llm-wiki-empty">No wiki pages found.</p>;
  }
  // Group by frontmatter type for a tidy index.
  const grouped = new Map<string, IndexPage[]>();
  for (const p of pages) {
    const list = grouped.get(p.type) ?? [];
    list.push(p);
    grouped.set(p.type, list);
  }
  const types = Array.from(grouped.keys()).sort();
  return (
    <div className="llm-wiki-index">
      {types.map((type) => (
        <section key={type}>
          <h3>{type}</h3>
          <ul>
            {grouped.get(type)!.map((p) => (
              <li key={p.slug}>
                <button type="button" onClick={() => onSelect(p.slug)}>
                  {p.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SearchResults({
  loading,
  results,
  onSelect,
}: {
  loading: boolean;
  results: SearchResult[];
  onSelect: (slug: string) => void;
}): React.ReactElement {
  if (loading && results.length === 0) return <p>Loading…</p>;
  if (results.length === 0) {
    return <p className="llm-wiki-empty">No matches.</p>;
  }
  return (
    <ul className="llm-wiki-results">
      {results.map((r) => (
        <li key={r.slug}>
          <button type="button" onClick={() => onSelect(r.slug)}>
            <span className="llm-wiki-result-title">{r.title}</span>
            <span className="llm-wiki-result-type">{r.type}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function PageDetail({
  loading,
  error,
  page,
  onWikilinkClick,
}: {
  loading: boolean;
  error: string | null;
  page: WikiPageData | null;
  onWikilinkClick: (slug: string) => void;
}): React.ReactElement {
  if (error !== null) return <p>Error: {error}</p>;
  if (loading || page === null) return <p>Loading…</p>;
  return <WikiPageView page={page} onWikilinkClick={onWikilinkClick} />;
}
