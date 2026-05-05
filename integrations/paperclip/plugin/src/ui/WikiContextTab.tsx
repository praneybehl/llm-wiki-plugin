import * as React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { injectWikiStyles } from "./styles.js";
import { wikiHref } from "./href.js";

interface RelevantResult {
  slug: string;
  title: string;
  type: string;
  score: number;
}

interface RelevantPayload {
  results: RelevantResult[];
}

function ContextList({ context }: PluginDetailTabProps): React.ReactElement {
  // No hardcoded topK — the worker resolves it from search_top_k config.
  const { data, loading, error } = usePluginData<RelevantPayload>(
    "relevantForIssue",
    {
      companyId: context.companyId,
      issueId: context.entityId,
    },
  );

  if (error !== null) {
    return (
      <div className="llm-wiki-context-tab" data-state="error">
        <p>Error: {error.message}</p>
      </div>
    );
  }
  if (loading || data === null) {
    return (
      <div className="llm-wiki-context-tab" data-state="loading">
        <p>Loading…</p>
      </div>
    );
  }
  if (data.results.length === 0) {
    return (
      <div className="llm-wiki-context-tab" data-state="empty">
        <p>No relevant wiki pages found.</p>
      </div>
    );
  }

  return (
    <div className="llm-wiki-context-tab">
      <ul className="llm-wiki-results">
        {data.results.map((r) => (
          <li key={r.slug} className="llm-wiki-result">
            <a
              href={wikiHref(context.companyPrefix, {
                kind: "page",
                slug: r.slug,
              })}
              data-wiki-slug={r.slug}
              className="llm-wiki-result-link"
            >
              <span className="llm-wiki-result-title">{r.title}</span>
              <span className="llm-wiki-result-type">{r.type}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WikiContextTab(
  props: PluginDetailTabProps,
): React.ReactElement {
  React.useEffect(() => injectWikiStyles(), []);
  return (
    <ErrorBoundary>
      <ContextList {...props} />
    </ErrorBoundary>
  );
}
