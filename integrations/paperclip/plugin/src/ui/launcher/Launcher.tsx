import * as React from "react";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import { wikiHref } from "../href.js";

/**
 * Sidebar entry point — a single navigation link to the wiki workspace.
 * Anything richer (search, recents, browse-by-type, health) lives in
 * the workspace itself; the sidebar slot exists only to make the wiki
 * one click away from any Company-scoped Paperclip route.
 */

export interface LauncherProps {
  context: PluginHostContext;
}

export function Launcher({ context }: LauncherProps): React.ReactElement {
  if (context.companyId === null) {
    return (
      <div className="llm-wiki-launcher">
        <p className="llm-wiki-empty">No Company is currently in scope.</p>
      </div>
    );
  }
  return (
    <div className="llm-wiki-launcher">
      <a
        href={wikiHref(context.companyPrefix, { kind: "landing" })}
        className="llm-wiki-launcher-link"
        data-testid="wiki-open"
      >
        LLM Wiki ↗
      </a>
    </div>
  );
}
