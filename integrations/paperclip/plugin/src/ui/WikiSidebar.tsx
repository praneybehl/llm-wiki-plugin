import * as React from "react";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { injectWikiStyles } from "./styles.js";
import { Launcher } from "./launcher/Launcher.js";

/**
 * Sidebar surface — a launcher into the wiki workspace, never a reader.
 * The actual reading happens at the page route (/{prefix}/llm-wiki).
 *
 * The launcher is shown on every Company-scoped Paperclip route because
 * Paperclip's sidebar slot mounts there. Cross-route state (recent
 * pages, query input) is intentionally local to the mount.
 */
export function WikiSidebar(props: PluginSidebarProps): React.ReactElement {
  React.useEffect(() => injectWikiStyles(), []);
  return (
    <ErrorBoundary>
      <Launcher context={props.context} />
    </ErrorBoundary>
  );
}
