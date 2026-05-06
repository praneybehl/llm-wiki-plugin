import * as React from "react";

/**
 * URL grammar for the wiki page slot.
 *
 * Paperclip registers a single route segment per page slot
 * (`<Route path=":pluginRoutePath" />`), so we cannot add nested routes.
 * Hash routing is the only feasible per-page URL scheme that survives
 * back/forward, copy-link, and external linking.
 *
 * | URL                                              | View                |
 * | ------------------------------------------------ | ------------------- |
 * | /{prefix}/llm-wiki                               | Landing             |
 * | /{prefix}/llm-wiki#concepts/transformer          | Page                |
 * | /{prefix}/llm-wiki#@concepts                     | Folder              |
 * | /{prefix}/llm-wiki?q=attention                   | Search              |
 * | /{prefix}/llm-wiki?q=attention#concepts/foo      | Search + page open  |
 * | /{prefix}/llm-wiki?view=setup                    | Setup walkthrough   |
 *
 * The `@` prefix on hashes is reserved for folder views and is therefore
 * not a valid leading character for a page slug.
 */

export type WikiTarget =
  | { kind: "landing" }
  | { kind: "page"; slug: string }
  | { kind: "folder"; folder: string }
  | { kind: "search"; query: string }
  | { kind: "setup" };

export type WikiLocation =
  | { kind: "landing" }
  | { kind: "page"; slug: string }
  | { kind: "folder"; folder: string }
  | { kind: "search"; query: string; slug: string | null }
  | { kind: "setup" };

export function wikiHref(
  companyPrefix: string | null | undefined,
  target: WikiTarget,
): string {
  // The plugin SDK's `companyPrefix` is typed `string | null`, but the
  // dashboard widget's host context surfaces it as `undefined` — guard
  // against both.
  if (companyPrefix === null || companyPrefix === undefined) return "#";
  const base = `/${companyPrefix}/llm-wiki`;
  switch (target.kind) {
    case "landing":
      return base;
    case "page":
      return `${base}#${encodeURIComponent(target.slug)}`;
    case "folder":
      return `${base}#@${encodeURIComponent(target.folder)}`;
    case "search":
      return `${base}?q=${encodeURIComponent(target.query)}`;
    case "setup":
      return `${base}?view=setup`;
  }
}

export function parseWikiLocation(): WikiLocation {
  if (typeof window === "undefined") return { kind: "landing" };
  const params = new URLSearchParams(window.location.search);
  if (params.get("view") === "setup") return { kind: "setup" };
  const q = params.get("q");
  const rawHash = window.location.hash.replace(/^#/, "");
  let slug = "";
  try {
    slug = rawHash ? decodeURIComponent(rawHash) : "";
  } catch {
    slug = rawHash;
  }
  if (q !== null && q.length > 0) {
    const splitSlug = slug && !slug.startsWith("@") ? slug : null;
    return { kind: "search", query: q, slug: splitSlug };
  }
  if (slug.startsWith("@")) {
    return { kind: "folder", folder: slug.slice(1) };
  }
  if (slug.length > 0) {
    return { kind: "page", slug };
  }
  return { kind: "landing" };
}

export function useWikiLocation(): WikiLocation {
  const [loc, setLoc] = React.useState<WikiLocation>(() => parseWikiLocation());
  React.useEffect(() => {
    function onChange(): void {
      setLoc(parseWikiLocation());
    }
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);
  return loc;
}

/**
 * Imperatively navigate to a wiki target. Used by components that need to
 * update the URL outside of an `<a href>` (form submits, keyboard handlers).
 *
 * Pushes a history entry so back/forward work, then dispatches popstate so
 * any mounted `useWikiLocation()` consumers re-read. The native popstate
 * event is not fired by `pushState` itself — we synthesise it.
 */
export function navigateTo(
  companyPrefix: string | null,
  target: WikiTarget,
): void {
  if (typeof window === "undefined") return;
  const href = wikiHref(companyPrefix, target);
  window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
