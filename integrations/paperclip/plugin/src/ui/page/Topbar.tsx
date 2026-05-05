import * as React from "react";
import { wikiHref, type WikiLocation } from "../href.js";

/**
 * Topbar — sits above the three-column workspace.
 *
 *   ← / →   ⌘K   /  concepts / transformer
 *
 * Three pieces:
 *   - Back / forward arrows wired to window.history navigation. Each
 *     hash change pushes a history entry so this round-trips naturally.
 *   - A ⌘K trigger that opens the QuickSwitcher (parent owns the open
 *     state; we just call onOpenSwitcher).
 *   - A breadcrumb. Each non-leaf segment is an anchor — `Wiki` goes to
 *     the landing view, intermediate path segments go to the matching
 *     folder view (`#@type`).
 */

export interface TopbarProps {
  location: WikiLocation;
  companyPrefix: string | null;
  onOpenSwitcher: () => void;
}

interface Crumb {
  label: string;
  href: string | null; // null = current/leaf, no link
}

function buildCrumbs(
  location: WikiLocation,
  companyPrefix: string | null,
): Crumb[] {
  const root: Crumb = {
    label: "Wiki",
    href: wikiHref(companyPrefix, { kind: "landing" }),
  };
  switch (location.kind) {
    case "landing":
      return [{ ...root, href: null }];
    case "folder":
      return [
        root,
        {
          label: location.folder,
          href: null,
        },
      ];
    case "page": {
      const parts = location.slug.split("/").filter(Boolean);
      if (parts.length === 0) return [root];
      const out: Crumb[] = [root];
      for (let i = 0; i < parts.length - 1; i++) {
        const folder = parts[i]!;
        out.push({
          label: folder,
          href: wikiHref(companyPrefix, { kind: "folder", folder }),
        });
      }
      out.push({ label: parts[parts.length - 1]!, href: null });
      return out;
    }
    case "search":
      return [root, { label: `Search: ${location.query}`, href: null }];
    case "setup":
      return [root, { label: "Setup", href: null }];
  }
}

export function Topbar({
  location,
  companyPrefix,
  onOpenSwitcher,
}: TopbarProps): React.ReactElement {
  const crumbs = React.useMemo(
    () => buildCrumbs(location, companyPrefix),
    [location, companyPrefix],
  );

  const onBack = React.useCallback(() => window.history.back(), []);
  const onForward = React.useCallback(() => window.history.forward(), []);

  return (
    <div className="llm-wiki-topbar">
      <div className="llm-wiki-topbar-nav">
        <button
          type="button"
          aria-label="Back"
          className="llm-wiki-topbar-arrow"
          onClick={onBack}
        >
          ←
        </button>
        <button
          type="button"
          aria-label="Forward"
          className="llm-wiki-topbar-arrow"
          onClick={onForward}
        >
          →
        </button>
      </div>
      <button
        type="button"
        className="llm-wiki-topbar-switcher"
        onClick={onOpenSwitcher}
        title="Quick switcher (⌘K / Ctrl-K)"
      >
        ⌘K
      </button>
      <nav aria-label="Breadcrumb" className="llm-wiki-topbar-crumbs">
        {crumbs.map((c, i) => (
          <React.Fragment key={`${c.label}-${i}`}>
            {i > 0 ? (
              <span className="llm-wiki-topbar-sep" aria-hidden="true">
                /
              </span>
            ) : null}
            {c.href !== null ? (
              <a className="llm-wiki-topbar-crumb" href={c.href}>
                {c.label}
              </a>
            ) : (
              <span className="llm-wiki-topbar-crumb" aria-current="page">
                {c.label}
              </span>
            )}
          </React.Fragment>
        ))}
      </nav>
    </div>
  );
}
