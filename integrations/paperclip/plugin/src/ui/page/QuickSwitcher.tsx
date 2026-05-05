import * as React from "react";
import { Command } from "cmdk";
import { navigateTo } from "../href.js";
import type { PageEntry } from "./FolderTree.js";

/**
 * Quick switcher (Cmd-K / Ctrl-K) — fuzzy-search jump to any wiki page.
 *
 * Built on Vercel's `cmdk`. Filtering, keyboard navigation, ARIA, and
 * focus trapping come from the library; we own the page list, the
 * grouping, and the navigate-on-select handler.
 *
 * Selecting an item calls `navigateTo` (which pushes a history entry
 * and dispatches popstate) and closes the dialog. Escape closes
 * without navigating; the calling Topbar wires the open/close state.
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
  const grouped = React.useMemo(() => groupByType(pages), [pages]);

  const onSelect = React.useCallback(
    (slug: string) => {
      navigateTo(companyPrefix, { kind: "page", slug });
      onOpenChange(false);
    },
    [companyPrefix, onOpenChange],
  );

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Quick switcher"
      className="llm-wiki-cmdk-dialog"
    >
      <Command.Input
        placeholder="Search pages…"
        className="llm-wiki-cmdk-input"
      />
      <Command.List className="llm-wiki-cmdk-list">
        <Command.Empty className="llm-wiki-empty">
          No matching pages.
        </Command.Empty>
        {grouped.map(([type, entries]) => (
          <Command.Group key={type} heading={type}>
            {entries.map((p) => (
              <Command.Item
                key={p.slug}
                value={`${p.title} ${p.slug}`}
                onSelect={() => onSelect(p.slug)}
                className="llm-wiki-cmdk-item"
              >
                <span className="llm-wiki-cmdk-item-title">{p.title}</span>
                <span className="llm-wiki-cmdk-item-slug">{p.slug}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}

function groupByType(pages: PageEntry[]): [string, PageEntry[]][] {
  const m = new Map<string, PageEntry[]>();
  for (const p of pages) {
    const list = m.get(p.type) ?? [];
    list.push(p);
    m.set(p.type, list);
  }
  return Array.from(m.entries())
    .map(([type, list]) => {
      list.sort((a, b) => a.title.localeCompare(b.title));
      return [type, list] as [string, PageEntry[]];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
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
