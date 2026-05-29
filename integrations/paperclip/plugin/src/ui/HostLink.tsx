import * as React from "react";

export interface HostLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
}

/**
 * Internal-route link that uses the host's React Router instead of a
 * full page reload.
 *
 * A plain `<a href="...">` on a path or query change triggers a hard
 * browser navigation. Paperclip's own SidebarNavItem uses React
 * Router's `<NavLink>` which intercepts the click and calls
 * `history.pushState`. We can't import that NavLink (it's not in the
 * plugin React shim), but we replicate the behaviour: intercept the
 * left-click, push the new URL, dispatch a synthetic `popstate` so
 * React Router's history listener picks it up — same listener our
 * own `useWikiLocation` hook reads from.
 *
 * Modifier-clicks (cmd / ctrl / shift / alt), middle-clicks, and
 * `target="_blank"` fall through to the browser default so "open in
 * new tab" still works. Hash-only navigations also fall through —
 * the browser handles those without a reload natively.
 */
export function HostLink({
  href,
  onClick,
  children,
  ...rest
}: HostLinkProps): React.ReactElement {
  const handleClick = React.useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (e.defaultPrevented) return;
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (rest.target && rest.target !== "_self") return;
      // Bare-fragment anchors (e.g. `#section` from rehype-autolink-
      // headings, or the OutlinePanel) need the browser's native
      // scroll-to-fragment behaviour.
      if (href.startsWith("#")) return;
      e.preventDefault();
      window.history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [href, onClick, rest.target],
  );
  return (
    <a href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
