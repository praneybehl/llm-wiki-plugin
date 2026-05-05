import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import { WikiPageView, type WikiPageData } from "../WikiPageView.js";
import {
  type OutlineHeading,
  extractHeadings,
} from "./OutlinePanel.js";
import { wikiHref, type WikiLocation } from "../href.js";
import { recordRecent } from "../recent.js";

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
          onPageLoaded={onPageLoaded}
        />
      );
    case "folder":
      return (
        <FolderView
          folder={location.folder}
          pages={pages}
          companyPrefix={context.companyPrefix}
          loading={indexResult.loading}
          onPageLoaded={onPageLoaded}
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
        <SearchView
          context={context}
          query={location.query}
          onPageLoaded={onPageLoaded}
        />
      );
    case "setup":
      return <SetupPlaceholder onPageLoaded={onPageLoaded} />;
  }
}

function useNotifyClear(
  onPageLoaded: ReaderProps["onPageLoaded"],
  deps: unknown[],
): void {
  React.useEffect(() => {
    onPageLoaded(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function Landing({
  loading,
  indexBody,
  onPageLoaded,
}: {
  loading: boolean;
  indexBody: string;
  onPageLoaded: ReaderProps["onPageLoaded"];
}): React.ReactElement {
  useNotifyClear(onPageLoaded, [indexBody]);
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
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{indexBody}</ReactMarkdown>
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
  onPageLoaded,
}: {
  folder: string;
  pages: IndexPage[];
  companyPrefix: string | null;
  loading: boolean;
  onPageLoaded: ReaderProps["onPageLoaded"];
}): React.ReactElement {
  useNotifyClear(onPageLoaded, [folder]);
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
            <a
              href={wikiHref(companyPrefix, { kind: "page", slug: p.slug })}
              data-wiki-slug={p.slug}
              className="llm-wiki-result-link"
            >
              <span className="llm-wiki-result-title">{p.title}</span>
              <span className="llm-wiki-result-type">{p.type}</span>
            </a>
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

  React.useEffect(() => {
    const data = pageResult.data;
    if (data === null || data === undefined || (data as WikiPageData & { error?: string }).error) {
      onPageLoaded(null);
      return;
    }
    const meta = (data as WikiPageData).meta;
    const dataSlug = (data as WikiPageData).slug;
    // Record into the launcher's "Recent" list. Best-effort — sessionStorage
    // may be disabled in some environments. Safe to call repeatedly because
    // recordRecent dedups by slug.
    const title =
      typeof meta.title === "string" && meta.title.length > 0
        ? meta.title
        : dataSlug;
    recordRecent({ slug: dataSlug, title });

    const host = articleHostRef.current;
    if (host === null) {
      onPageLoaded({ meta, slug: dataSlug, headings: [] });
      return;
    }
    // The article is rendered as a child of articleHostRef. extractHeadings
    // expects the article element directly; fall back to the host if there
    // is no nested article (defensive — should never happen in practice).
    const article = host.querySelector("article.llm-wiki-page") ?? host;
    onPageLoaded({
      meta,
      slug: dataSlug,
      headings: extractHeadings(article as HTMLElement),
    });
  }, [pageResult.data, onPageLoaded]);

  if (pageResult.error !== null) {
    return <p className="llm-wiki-error">Error: {pageResult.error.message}</p>;
  }
  if (pageResult.loading || pageResult.data === null) {
    return <p>Loading…</p>;
  }
  if ((pageResult.data as WikiPageData & { error?: string }).error) {
    return (
      <p className="llm-wiki-error">
        Error: {(pageResult.data as { error: string }).error}
      </p>
    );
  }
  return (
    <div ref={articleHostRef}>
      <WikiPageView
        page={pageResult.data as WikiPageData}
        companyPrefix={context.companyPrefix}
      />
    </div>
  );
}

function SearchView({
  context,
  query,
  onPageLoaded,
}: {
  context: PluginHostContext;
  query: string;
  onPageLoaded: ReaderProps["onPageLoaded"];
}): React.ReactElement {
  const searchResult = usePluginData<SearchPayload>("searchWiki", {
    companyId: context.companyId,
    projectId: context.projectId,
    query,
  });
  useNotifyClear(onPageLoaded, [query]);
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
            <a
              href={wikiHref(context.companyPrefix, {
                kind: "page",
                slug: r.slug,
              })}
              data-wiki-slug={r.slug}
              className="llm-wiki-result-link"
            >
              <span className="llm-wiki-result-title">{r.title}</span>
              <span className="llm-wiki-result-type">{r.type}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SetupPlaceholder({
  onPageLoaded,
}: {
  onPageLoaded: ReaderProps["onPageLoaded"];
}): React.ReactElement {
  useNotifyClear(onPageLoaded, []);
  return (
    <section className="llm-wiki-setup">
      <h2>Setup</h2>
      <p className="llm-wiki-empty">
        Setup walkthrough lands in the next release. For now, see the
        plugin README for the install runbook.
      </p>
    </section>
  );
}
