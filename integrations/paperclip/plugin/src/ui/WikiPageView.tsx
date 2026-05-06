import * as React from "react";
import { WikiMarkdown } from "./WikiMarkdown.js";

/**
 * Renders one wiki page: header (title + frontmatter type badge) plus
 * the body, run through the shared WikiMarkdown pipeline.
 */

export interface WikiPageData {
  slug: string;
  meta: Record<string, unknown>;
  body: string;
}

export interface WikiPageViewProps {
  page: WikiPageData;
  /**
   * Active company prefix. Wikilinks inside the rendered body resolve to
   * `/{companyPrefix}/llm-wiki#{slug}`. When null (e.g. before the host
   * context resolves), wikilinks fall back to a `#` no-op href.
   */
  companyPrefix: string | null;
}

export function WikiPageView({
  page,
  companyPrefix,
}: WikiPageViewProps): React.ReactElement {
  const title =
    typeof page.meta.title === "string" && page.meta.title.length > 0
      ? page.meta.title
      : page.slug;
  const type =
    typeof page.meta.type === "string" && page.meta.type.length > 0
      ? page.meta.type
      : null;

  return (
    <article className="llm-wiki-page" data-slug={page.slug}>
      <header className="llm-wiki-page-header">
        <h1>{title}</h1>
        {type !== null ? (
          <span className="llm-wiki-type-badge">{type}</span>
        ) : null}
      </header>
      <WikiMarkdown body={page.body} companyPrefix={companyPrefix} />
    </article>
  );
}
