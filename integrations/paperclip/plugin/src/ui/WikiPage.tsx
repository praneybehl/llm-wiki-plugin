import * as React from "react";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { injectWikiStyles } from "./styles.js";
import { useWikiLocation } from "./href.js";
import { FolderTree, type PageEntry } from "./page/FolderTree.js";
import { Reader, type ReaderPageContext } from "./page/Reader.js";
import { PropertiesPanel } from "./page/PropertiesPanel.js";
import { OutlinePanel } from "./page/OutlinePanel.js";
import { BacklinksPanel } from "./page/BacklinksPanel.js";
import { Topbar } from "./page/Topbar.js";
import {
  QuickSwitcher,
  useQuickSwitcherShortcut,
} from "./page/QuickSwitcher.js";

/**
 * The wiki workspace — three-column layout served at the page slot route.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ left rail (FolderTree)                       │
 *   │ center (Reader: landing/folder/page/search)  │
 *   │ right rail (Properties + Outline + Backlinks)│
 *   └──────────────────────────────────────────────┘
 *
 * Backlinks is wired in Phase D; the right rail renders Properties +
 * Outline only in this phase. The Setup view (`?view=setup`) renders a
 * placeholder until Phase H lands.
 */

interface IndexPayload {
  index: string;
  shards: { name: string; text: string }[];
  pages: PageEntry[];
}

function Workspace({
  context,
}: PluginPageProps): React.ReactElement {
  const location = useWikiLocation();
  const [tree, setTree] = React.useState("");

  const indexResult = usePluginData<IndexPayload>("loadIndex", {
    companyId: context.companyId,
    projectId: context.projectId,
  });

  const [page, setPage] = React.useState<ReaderPageContext | null>(null);
  const onPageLoaded = React.useCallback(
    (next: ReaderPageContext | null) => setPage(next),
    [],
  );

  const switcher = useQuickSwitcherShortcut();

  if (context.companyId === null) {
    return (
      <div className="llm-wiki-workspace">
        <p className="llm-wiki-empty">No Company is currently in scope.</p>
      </div>
    );
  }

  const currentSlug = location.kind === "page" ? location.slug : null;

  return (
    <div
      className="llm-wiki-workspace llm-wiki-page-surface"
      data-view={location.kind}
    >
      <Topbar
        location={location}
        companyPrefix={context.companyPrefix}
        onOpenSwitcher={() => switcher.setOpen(true)}
      />
      <QuickSwitcher
        pages={indexResult.data?.pages ?? []}
        companyPrefix={context.companyPrefix}
        open={switcher.open}
        onOpenChange={switcher.setOpen}
      />
      <div className="llm-wiki-workspace-grid">
      <aside className="llm-wiki-workspace-left">
        <input
          type="search"
          className="llm-wiki-search-input"
          placeholder="Filter pages…"
          value={tree}
          onChange={(e) => setTree(e.target.value)}
        />
        <FolderTree
          pages={indexResult.data?.pages ?? []}
          companyPrefix={context.companyPrefix}
          currentSlug={currentSlug}
          titleFilter={tree}
        />
      </aside>
      <main className="llm-wiki-workspace-center">
        <Reader
          context={context}
          location={location}
          onPageLoaded={onPageLoaded}
        />
      </main>
      <aside className="llm-wiki-workspace-right">
        {page === null ? (
          <p className="llm-wiki-empty">Open a page to see its metadata.</p>
        ) : (
          <>
            <PropertiesPanel meta={page.meta} />
            <OutlinePanel headings={page.headings} />
            <BacklinksPanel
              companyId={context.companyId}
              projectId={context.projectId}
              companyPrefix={context.companyPrefix}
              slug={page.slug}
            />
          </>
        )}
      </aside>
      </div>
    </div>
  );
}

export function WikiPage(props: PluginPageProps): React.ReactElement {
  React.useEffect(() => injectWikiStyles(), []);
  return (
    <ErrorBoundary>
      <Workspace {...props} />
    </ErrorBoundary>
  );
}
