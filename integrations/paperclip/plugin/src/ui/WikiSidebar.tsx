import * as React from "react";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { WikiBrowser } from "./WikiBrowser.js";

export function WikiSidebar(props: PluginSidebarProps): React.ReactElement {
  return (
    <ErrorBoundary>
      <WikiBrowser
        context={props.context}
        className="llm-wiki-sidebar-surface"
      />
    </ErrorBoundary>
  );
}
