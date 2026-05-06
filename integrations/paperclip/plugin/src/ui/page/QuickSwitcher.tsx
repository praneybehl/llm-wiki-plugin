import * as React from "react";
import { navigateTo } from "../href.js";
import type { PageEntry } from "./FolderTree.js";

/**
 * Quick switcher (Cmd-K / Ctrl-K) — fuzzy-search jump to any wiki page.
 *
 * In-house implementation rather than cmdk / Radix Dialog: Paperclip's
 * plugin React shim only re-exports a fixed allowlist of hooks
 * (`useInsertionEffect` is not in it), which breaks Radix's internals.
 * The component below uses only the hooks the host shim actually
 * provides.
 *
 * Behaviour: ↑/↓ moves the selection, Enter navigates, Escape closes,
 * clicks outside the panel close. Items are filtered by a
 * case-insensitive substring match against title and slug.
 */

export interface QuickSwitcherProps {
  pages: PageEntry[];
  companyPrefix: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function QuickSwitcher({
  pages,
  companyPrefix,
  open,
  onOpenChange,
}: QuickSwitcherProps): React.ReactElement | null {
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return pages;
    return pages.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q),
    );
  }, [pages, query]);

  // Reset selection / query whenever the dialog re-opens.
  React.useEffect(() => {
    if (open) {
      setActiveIndex(0);
      setQuery("");
      inputRef.current?.focus();
    }
  }, [open]);

  React.useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  function commit(slug: string): void {
    navigateTo(companyPrefix, { kind: "page", slug });
    onOpenChange(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = filtered[activeIndex];
      if (p) commit(p.slug);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
    }
  }

  return (
    <div
      className="llm-wiki-cmdk-overlay"
      role="dialog"
      aria-label="Quick switcher"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="llm-wiki-cmdk-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          type="search"
          className="llm-wiki-cmdk-input"
          placeholder="Search pages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search pages"
        />
        <ul className="llm-wiki-cmdk-list">
          {filtered.length === 0 ? (
            <li className="llm-wiki-empty">No matching pages.</li>
          ) : (
            filtered.map((p, i) => (
              <li
                key={p.slug}
                className="llm-wiki-cmdk-item"
                data-selected={i === activeIndex ? "true" : undefined}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => commit(p.slug)}
              >
                <span className="llm-wiki-cmdk-item-title">{p.title}</span>
                <span className="llm-wiki-cmdk-item-slug">{p.slug}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

/**
 * Convenience hook — wires the Cmd/Ctrl-K shortcut at the document
 * level so any consumer (e.g. Topbar) can ask "is the switcher open?"
 * without owning the keydown listener itself.
 */
export function useQuickSwitcherShortcut(): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen };
}
