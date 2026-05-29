import * as React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import { WikiPageView, type WikiPageData } from "../WikiPageView.js";
import { WikiMarkdown } from "../WikiMarkdown.js";
import {
  type OutlineHeading,
  extractHeadings,
} from "./OutlinePanel.js";
import { wikiHref, type WikiLocation } from "../href.js";
import { HostLink } from "../HostLink.js";
import { SetupView } from "../setup/SetupView.js";

/**
 * Reader — center-column dispatcher for the wiki workspace.
 *
 * Picks one of five views based on the parsed URL location and emits a
 * `{ meta, headings }` payload back to the workspace shell so the right
 * rail (Properties, Outline, Backlinks) can render the active page's
 * metadata. For non-page views, `onPageLoaded` is called with `null`.
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

export interface ReaderPageContext {
  meta: Record<string, unknown>;
  slug: string;
  headings: OutlineHeading[];
}

export interface ReaderProps {
  context: PluginHostContext;
  location: WikiLocation;
  onPageLoaded: (page: ReaderPageContext | null) => void;
}

export function Reader({
  context,
  location,
  onPageLoaded,
}: ReaderProps): React.ReactElement {
  const indexResult = usePluginData<IndexPayload>("loadIndex", {
    companyId: context.companyId,
    projectId: context.projectId,
  });
  const pages = indexResult.data?.pages ?? [];

  switch (location.kind) {
    case "landing":
      return (
        <Landing
          loading={indexResult.loading}
          indexBody={indexResult.data?.index ?? ""}
          companyPrefix={context.companyPrefix}
        />
      );
    case "folder":
      return (
        <FolderView
          folder={location.folder}
          pages={pages}
          companyPrefix={context.companyPrefix}
          loading={indexResult.loading}
        />
      );
    case "page":
      return (
        <PageRead
          context={context}
          slug={location.slug}
          onPageLoaded={onPageLoaded}
        />
      );
    case "search":
      return (
        <SearchView context={context} query={location.query} />
      );
    case "setup":
      return <SetupView context={context} />;
  }
}

function Landing({
  loading,
  indexBody,
  companyPrefix,
}: {
  loading: boolean;
  indexBody: string;
  companyPrefix: string | null;
}): React.ReactElement {
  return (
    <section className="llm-wiki-landing">
      {loading && indexBody === "" ? (
        <p className="llm-wiki-empty">Loading the wiki…</p>
      ) : indexBody === "" ? (
        <p className="llm-wiki-empty">
          This wiki has no top-level <code>index.md</code>. Pick a page from
          the tree on the left to start reading.
        </p>
      ) : (
        <article className="llm-wiki-landing-index">
          <WikiMarkdown body={indexBody} companyPrefix={companyPrefix} />
        </article>
      )}
    </section>
  );
}

function FolderView({
  folder,
  pages,
  companyPrefix,
  loading,
}: {
  folder: string;
  pages: IndexPage[];
  companyPrefix: string | null;
  loading: boolean;
}): React.ReactElement {
  const inFolder = pages
    .filter(
      (p) =>
        p.relPath.startsWith(`${folder}/`) ||
        p.slug.startsWith(`${folder}/`),
    )
    .sort((a, b) => a.title.localeCompare(b.title));
  return (
    <section className="llm-wiki-folder-view">
      <header>
        <h2>
          <span aria-hidden="true">📁</span> {folder}
        </h2>
        <p className="llm-wiki-empty">
          {loading ? "Loading…" : `${inFolder.length} pages`}
        </p>
      </header>
      <ul className="llm-wiki-results">
        {inFolder.map((p) => (
          <li key={p.slug} className="llm-wiki-result">
            <HostLink
              href={wikiHref(companyPrefix, { kind: "page", slug: p.slug })}
              data-wiki-slug={p.slug}
              className="llm-wiki-result-link"
            >
              <span className="llm-wiki-result-title">{p.title}</span>
              <span className="llm-wiki-result-type">{p.type}</span>
            </HostLink>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PageRead({
  context,
  slug,
  onPageLoaded,
}: {
  context: PluginHostContext;
  slug: string;
  onPageLoaded: ReaderProps["onPageLoaded"];
}): React.ReactElement {
  const pageResult = usePluginData<WikiPageData & { error?: string }>(
    "readPage",
    {
      companyId: context.companyId,
      projectId: context.projectId,
      slug,
    },
  );
  const articleHostRef = React.useRef<HTMLDivElement>(null);

  // Narrow once: the readPage worker can return either a page or an
  // `{ error }` envelope. Everything below treats `page` as the resolved
  // page or null.
  const data = pageResult.data;
  const page: WikiPageData | null =
    data && !(data as { error?: string }).error
      ? (data as WikiPageData)
      : null;

  React.useEffect(() => {
    if (page === null) return;
    const host = articleHostRef.current;
    const article = host?.querySelector("article.llm-wiki-page") ?? host;
    onPageLoaded({
      meta: page.meta,
      slug: page.slug,
      headings: article ? extractHeadings(article as HTMLElement) : [],
    });
  }, [page, onPageLoaded]);

  if (pageResult.error !== null) {
    return <p className="llm-wiki-error">Error: {pageResult.error.message}</p>;
  }
  if (pageResult.loading || data === null) {
    return <p>Loading…</p>;
  }
  if (page === null) {
    return (
      <p className="llm-wiki-error">
        Error: {(data as { error: string }).error}
      </p>
    );
  }
  return (
    <div ref={articleHostRef}>
      <WikiPageView page={page} companyPrefix={context.companyPrefix} />
    </div>
  );
}

function SearchView({
  context,
  query,
}: {
  context: PluginHostContext;
  query: string;
}): React.ReactElement {
  const searchResult = usePluginData<SearchPayload>("searchWiki", {
    companyId: context.companyId,
    projectId: context.projectId,
    query,
  });
  return (
    <section className="llm-wiki-search-view">
      <header>
        <h2>Search results</h2>
        <p className="llm-wiki-empty">
          {searchResult.loading
            ? "Searching…"
            : `${searchResult.data?.results?.length ?? 0} matches for “${query}”`}
        </p>
      </header>
      <ul className="llm-wiki-results">
        {(searchResult.data?.results ?? []).map((r) => (
          <li key={r.slug} className="llm-wiki-result">
            <HostLink
              href={wikiHref(context.companyPrefix, {
                kind: "page",
                slug: r.slug,
              })}
              data-wiki-slug={r.slug}
              className="llm-wiki-result-link"
            >
              <span className="llm-wiki-result-title">{r.title}</span>
              <span className="llm-wiki-result-type">{r.type}</span>
            </HostLink>
          </li>
        ))}
      </ul>
    </section>
  );
}

