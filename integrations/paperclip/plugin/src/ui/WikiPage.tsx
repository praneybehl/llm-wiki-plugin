import * as React from "react";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { WikiBrowser } from "./WikiBrowser.js";
import { injectWikiStyles } from "./styles.js";

export function WikiPage(props: PluginPageProps): React.ReactElement {
  React.useEffect(() => injectWikiStyles(), []);
  return (
    <ErrorBoundary>
      <WikiBrowser
        context={props.context}
        className="llm-wiki-page-surface"
      />
    </ErrorBoundary>
  );
}
