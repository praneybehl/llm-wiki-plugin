import * as React from "react";

/**
 * Outline panel — table-of-contents links to in-page heading anchors.
 *
 * Headings are extracted from the rendered article DOM (after rehype-slug
 * has assigned ids) by the Reader and passed in. We do not parse the
 * markdown source separately — that path would re-derive ids and risk
 * drift with rehype-slug's own slugger.
 */

export interface OutlineHeading {
  level: number;
  text: string;
  id: string;
}

export interface OutlinePanelProps {
  headings: OutlineHeading[];
}

export function OutlinePanel({
  headings,
}: OutlinePanelProps): React.ReactElement {
  if (headings.length === 0) {
    return (
      <section className="llm-wiki-outline llm-wiki-outline-empty">
        <h3>Outline</h3>
        <p className="llm-wiki-empty">No headings on this page.</p>
      </section>
    );
  }
  return (
    <section className="llm-wiki-outline">
      <h3>Outline</h3>
      <ul>
        {headings.map((h) => (
          <li key={h.id} data-level={String(h.level)}>
            <a href={`#${h.id}`}>{h.text}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Helper that the Reader uses to extract `OutlineHeading[]` from a rendered
 * `<article>` element. Defined here to keep the data shape co-located with
 * the consumer.
 */
export function extractHeadings(article: HTMLElement): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  // We render an h1 for the page title in WikiPageView, but the page-title
  // h1 lives inside `.llm-wiki-page-header` and isn't useful in the outline.
  // We restrict to h2-h6 to skip it.
  const nodes = article.querySelectorAll("h2, h3, h4, h5, h6");
  for (const node of Array.from(nodes)) {
    const id = node.id;
    if (!id) continue;
    const level = Number(node.tagName.slice(1));
    if (Number.isNaN(level)) continue;
    out.push({ level, text: (node.textContent ?? "").trim(), id });
  }
  return out;
}
