import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeHighlight from "rehype-highlight";
import { wikiHref } from "./href.js";
import { HostLink } from "./HostLink.js";

/**
 * The shared markdown rendering pipeline used by both the page reader
 * (WikiPageView) and the landing-view index renderer. Wikilinks expand
 * to `/{prefix}/llm-wiki#{slug}` anchors; headings get stable ids and
 * permalink anchors; code blocks get hljs language classes.
 *
 * Kept separate from WikiPageView's article chrome (header, type
 * badge) so the index can render its own body without inheriting
 * page-specific styling.
 */

type RehypePlugins = React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"];
type RemarkPlugins = React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"];

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

interface MarkdownAnchorProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
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
      <HostLink
        href={wikiHref(companyPrefix, { kind: "page", slug })}
        data-wiki-slug={slug}
        {...rest}
      >
        {children}
      </HostLink>
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
  rehypeAutolinkHeadings,
  [rehypeHighlight, { ignoreMissing: true }],
];

export interface WikiMarkdownProps {
  body: string;
  companyPrefix: string | null;
}

export function WikiMarkdown({
  body,
  companyPrefix,
}: WikiMarkdownProps): React.ReactElement {
  const expanded = React.useMemo(() => expandWikilinks(body), [body]);
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
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={components}
      urlTransform={preserveWikiScheme}
    >
      {expanded}
    </ReactMarkdown>
  );
}
