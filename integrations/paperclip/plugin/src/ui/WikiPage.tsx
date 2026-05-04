import * as React from "react";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { WikiBrowser } from "./WikiBrowser.js";

export function WikiPage(props: PluginPageProps): React.ReactElement {
  return (
    <ErrorBoundary>
      <WikiBrowser
        context={props.context}
        className="llm-wiki-page-surface"
      />
    </ErrorBoundary>
  );
}
