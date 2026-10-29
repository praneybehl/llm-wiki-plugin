import { Marked, type Tokens } from "marked";
import { parseFrontmatter, type FrontmatterValue } from "../core/frontmatter";
import { escapeHtml } from "../http/util";

export interface RenderedPage {
  html: string;
  frontmatter: Record<string, FrontmatterValue>;
  outline: { depth: number; text: string; id: string }[];
}

const SAFE_HREF = /^(https?:|mailto:|#|\/(?!\/)|\.{0,2}\/|[^:]*$)/i;
const WIKILINK = /^\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/;

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/** URL that resolves a `[[wikilink]]` target to a page in the UI. */
export function wikilinkHref(wiki: string, target: string): string {
  return `/ui/${wiki}/go?slug=${encodeURIComponent(target.trim())}`;
}

/** Resolve a relative `.md` link against the current page path. */
function relativePageHref(wiki: string, pagePath: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:|^\/|^#/i.test(href)) return null;
  const [target = "", hash] = href.split("#", 2);
  if (!target.endsWith(".md")) return null;
  const parts = pagePath.split("/").slice(0, -1);
  for (const seg of decodeURI(target).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return `/ui/${wiki}/page?path=${encodeURIComponent(parts.join("/"))}${hash ? `#${hash}` : ""}`;
}

/** Render a wiki page: raw HTML is escaped, unsafe links are dropped, wikilinks become UI links. */
export function renderPage(wiki: string, pagePath: string, content: string): RenderedPage {
  const fm = parseFrontmatter(content);
  const outline: RenderedPage["outline"] = [];
  const used = new Map<string, number>();
  const marked = new Marked({ gfm: true, async: false });
  marked.use({
    extensions: [
      {
        name: "wikilink",
        level: "inline",
        start: (src: string) => {
          const i = src.indexOf("[[");
          return i < 0 ? undefined : i;
        },
        tokenizer(src: string) {
          const m = WIKILINK.exec(src);
          if (!m) return undefined;
          return { type: "wikilink", raw: m[0], target: m[1]!.trim(), label: (m[2] ?? m[1]!).trim() };
        },
        renderer(token) {
          const t = token as Tokens.Generic & { target: string; label: string };
          return `<a class="wikilink" href="${escapeHtml(wikilinkHref(wiki, t.target))}">${escapeHtml(t.label)}</a>`;
        },
      },
    ],
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
      heading({ tokens, depth, text }: Tokens.Heading) {
        const base = slugify(text);
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        const id = n === 0 ? base : `${base}-${n}`;
        outline.push({ depth, text, id });
        return `<h${depth} id="${escapeHtml(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        try {
          const page = relativePageHref(wiki, pagePath, href);
          if (page) return `<a href="${escapeHtml(page)}">${inner}</a>`;
        } catch {
          return inner;
        }
        if (!SAFE_HREF.test(href)) return inner;
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        const external = /^https?:/i.test(href) ? ' rel="noopener noreferrer nofollow"' : "";
        return `<a href="${escapeHtml(href)}"${t}${external}>${inner}</a>`;
      },
      image({ href, text }: Tokens.Image) {
        // Images are not loaded (strict CSP); show a link instead.
        if (!SAFE_HREF.test(href)) return escapeHtml(text);
        return `<a class="image-link" href="${escapeHtml(href)}" rel="noopener noreferrer nofollow">image: ${escapeHtml(text || href)}</a>`;
      },
    },
  });
  const html = marked.parse(fm.body, { async: false });
  return { html, frontmatter: fm.meta, outline };
}
