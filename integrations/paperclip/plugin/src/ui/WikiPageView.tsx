import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeHighlight from "rehype-highlight";
import { wikiHref } from "./href.js";

type RehypePlugins = React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"];
type RemarkPlugins = React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"];

/**
 * Renders one wiki page as markdown with GFM extensions and the v0.4
 * reader pipeline:
 *   - rehype-slug: stable ids on h1–h6 (used by the outline panel).
 *   - rehype-autolink-headings: tiny `#` permalink anchor inside each
 *     heading.
 *   - rehype-highlight: highlight.js classes on fenced code blocks.
 *
 * Wikilink handling: `[[slug]]` / `[[slug|display]]` are transformed at
 * the source level (string substitution) into standard markdown links
 * with a `wiki:` sentinel scheme. The custom <a> renderer detects the
 * sentinel and rewrites the href to a real `/{prefix}/llm-wiki#{slug}`
 * URL — the URL is the source of truth for navigation, not a callback.
 */

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const SENTINEL_PROTOCOL = "wiki:";

function expandWikilinks(body: string): string {
  return body.replace(
    WIKILINK_RE,
    (_match, rawSlug: string, rawDisplay?: string) => {
      const slug = rawSlug.trim();
      const display = (rawDisplay ?? slug).trim();
      return `[${display}](${SENTINEL_PROTOCOL}${slug})`;
    },
  );
}

/**
 * react-markdown's default urlTransform allow-lists http/https/mailto/tel.
 * Our `wiki:` sentinel falls outside that, so the default transform drops
 * the href entirely. Pass through wiki: URLs unmodified; defer to the
 * default sanitizer for everything else.
 */
function preserveWikiScheme(url: string): string {
  if (url.startsWith(SENTINEL_PROTOCOL)) return url;
  if (
    /^(https?|mailto|tel):/.test(url) ||
    url.startsWith("#") ||
    url.startsWith("/")
  ) {
    return url;
  }
  return "";
}

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

interface MarkdownAnchorProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href?: string;
  companyPrefix: string | null;
}

function MarkdownAnchor({
  href,
  children,
  companyPrefix,
  ...rest
}: MarkdownAnchorProps): React.ReactElement {
  if (typeof href === "string" && href.startsWith(SENTINEL_PROTOCOL)) {
    const slug = href.slice(SENTINEL_PROTOCOL.length);
    return (
      <a
        href={wikiHref(companyPrefix, { kind: "page", slug })}
        data-wiki-slug={slug}
        {...rest}
      >
        {children}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}

const REMARK_PLUGINS: RemarkPlugins = [remarkGfm];
const REHYPE_PLUGINS: RehypePlugins = [
  rehypeSlug,
  // Default behaviour ("prepend") puts the anchor before the heading text,
  // which we hide via CSS unless the heading is hovered.
  rehypeAutolinkHeadings,
  // ignoreMissing keeps unrecognised languages as plain `<code>` instead
  // of throwing.
  [rehypeHighlight, { ignoreMissing: true }],
];

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

  const expanded = React.useMemo(
    () => expandWikilinks(page.body),
    [page.body],
  );

  const components = React.useMemo<{
    a: (
      props: React.AnchorHTMLAttributes<HTMLAnchorElement>,
    ) => React.ReactElement;
  }>(
    () => ({
      a: (props) => (
        <MarkdownAnchor {...props} companyPrefix={companyPrefix} />
      ),
    }),
    [companyPrefix],
  );

  return (
    <article className="llm-wiki-page" data-slug={page.slug}>
      <header className="llm-wiki-page-header">
        <h1>{title}</h1>
        {type !== null ? (
          <span className="llm-wiki-type-badge">{type}</span>
        ) : null}
      </header>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
        urlTransform={preserveWikiScheme}
      >
        {expanded}
      </ReactMarkdown>
    </article>
  );
}
