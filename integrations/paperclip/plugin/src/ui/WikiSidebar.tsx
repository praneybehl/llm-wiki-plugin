import * as React from "react";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { WikiBrowser } from "./WikiBrowser.js";
import { injectWikiStyles } from "./styles.js";

export function WikiSidebar(props: PluginSidebarProps): React.ReactElement {
  React.useEffect(() => injectWikiStyles(), []);
  return (
    <ErrorBoundary>
      <WikiBrowser
        context={props.context}
        className="llm-wiki-sidebar-surface"
      />
    </ErrorBoundary>
  );
}
