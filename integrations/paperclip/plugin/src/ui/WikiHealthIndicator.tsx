import * as React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { ErrorBoundary } from "./ErrorBoundary.js";

interface WikiHealth {
  pageCount: number;
  indexLines: number;
  linkDensity: number;
  scalingMessages: string[];
  lintStatus: "pass" | "warn" | "fail";
  lintFindings: { totalPages?: number } | null;
  wikiPathMissing: boolean;
}

function HealthCard({ context }: PluginWidgetProps): React.ReactElement {
  const { data, loading, error } = usePluginData<WikiHealth>("wikiHealth", {
    companyId: context.companyId,
    projectId: context.projectId,
  });

  if (context.companyId === null) {
    return (
      <div className="llm-wiki-health">
        <header>Wiki health</header>
        <p>No Company is currently in scope.</p>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="llm-wiki-health" data-state="error">
        <header>Wiki health</header>
        <p className="llm-wiki-error">Error: {error.message}</p>
      </div>
    );
  }

  if (loading || data === null) {
    return (
      <div className="llm-wiki-health" data-state="loading">
        <header>Wiki health</header>
        <p>Loading…</p>
      </div>
    );
  }

  if (data.wikiPathMissing) {
    return (
      <div className="llm-wiki-health" data-state="missing">
        <header>Wiki health</header>
        <p>Wiki path not configured for this Company.</p>
        <p className="llm-wiki-hint">
          Run <code>/wiki:init</code> from any agent in this Company, or set{" "}
          <code>wiki_path</code> in the plugin settings.
        </p>
      </div>
    );
  }

  return (
    <div className="llm-wiki-health" data-state="ok">
      <header>Wiki health</header>
      <dl className="llm-wiki-health-stats">
        <dt>Pages</dt>
        <dd>{data.pageCount}</dd>
        <dt>Lint</dt>
        <dd>
          <span
            className="llm-wiki-status-badge"
            data-lint-status={data.lintStatus}
          >
            {data.lintStatus}
          </span>
        </dd>
        <dt>Link density</dt>
        <dd>{data.linkDensity.toFixed(1)} per page</dd>
      </dl>
      {data.scalingMessages.length > 0 ? (
        <ul className="llm-wiki-scaling-messages">
          {data.scalingMessages.map((msg, i) => (
            <li key={i}>{msg}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function WikiHealthIndicator(
  props: PluginWidgetProps,
): React.ReactElement {
  return (
    <ErrorBoundary>
      <HealthCard {...props} />
    </ErrorBoundary>
  );
}
