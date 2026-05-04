import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders one wiki page as markdown with GFM extensions.
 *
 * Wikilink handling: `[[slug]]` / `[[slug|display]]` are transformed at
 * the source level (string substitution) into standard markdown links
 * with a sentinel scheme. The custom <a> renderer detects the sentinel
 * and surfaces them as internal links with a data-wiki-slug attribute,
 * dispatching to the optional onWikilinkClick handler. This keeps the
 * markdown pipeline stock — no third-party remark-wiki-link dependency —
 * and makes parity with our extractWikilinks regex trivial to verify.
 */

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const SENTINEL_PROTOCOL = "wiki:";

function expandWikilinks(body: string): string {
  return body.replace(WIKILINK_RE, (_match, rawSlug: string, rawDisplay?: string) => {
    const slug = rawSlug.trim();
    const display = (rawDisplay ?? slug).trim();
    // Use a sentinel scheme so the <a> renderer can detect wiki links
    // without colliding with regular http(s) targets.
    return `[${display}](${SENTINEL_PROTOCOL}${slug})`;
  });
}

/**
 * react-markdown's default urlTransform allow-lists http/https/mailto/tel.
 * Our `wiki:` sentinel falls outside that, so the default transform drops
 * the href entirely. Pass through wiki: URLs unmodified; defer to the
 * default sanitizer for everything else.
 */
function preserveWikiScheme(url: string): string {
  if (url.startsWith(SENTINEL_PROTOCOL)) return url;
  // Allow common safe schemes; drop everything else (mirrors react-markdown's
  // default behavior).
  if (/^(https?|mailto|tel):/.test(url) || url.startsWith("#") || url.startsWith("/")) {
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
  onWikilinkClick?: (slug: string) => void;
}

function MarkdownAnchor(
  props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string },
  onWikilinkClick?: (slug: string) => void,
): React.ReactElement {
  const { href, children, ...rest } = props;
  if (typeof href === "string" && href.startsWith(SENTINEL_PROTOCOL)) {
    const slug = href.slice(SENTINEL_PROTOCOL.length);
    return (
      <a
        href={`#wiki/${slug}`}
        data-wiki-slug={slug}
        onClick={(e) => {
          if (onWikilinkClick) {
            e.preventDefault();
            onWikilinkClick(slug);
          }
        }}
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

export function WikiPageView({
  page,
  onWikilinkClick,
}: WikiPageViewProps): React.ReactElement {
  const title =
    typeof page.meta.title === "string" && page.meta.title.length > 0
      ? page.meta.title
      : page.slug;
  const type =
    typeof page.meta.type === "string" && page.meta.type.length > 0
      ? page.meta.type
      : null;

  const expanded = React.useMemo(() => expandWikilinks(page.body), [page.body]);

  const components = React.useMemo<{
    a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.ReactElement;
  }>(
    () => ({
      a: (props) => MarkdownAnchor(props, onWikilinkClick),
    }),
    [onWikilinkClick],
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
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={preserveWikiScheme}
      >
        {expanded}
      </ReactMarkdown>
    </article>
  );
}
