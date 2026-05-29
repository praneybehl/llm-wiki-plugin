import * as React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { wikiHref } from "../href.js";
import { HostLink } from "../HostLink.js";

interface BacklinkResult {
  slug: string;
  title: string;
  type: string;
  snippet: string;
}

interface BacklinksPayload {
  results: BacklinkResult[];
}

export interface BacklinksPanelProps {
  companyId: string | null;
  projectId: string | null;
  companyPrefix: string | null;
  slug: string;
}

export function BacklinksPanel({
  companyId,
  projectId,
  companyPrefix,
  slug,
}: BacklinksPanelProps): React.ReactElement {
  const { data, loading, error } = usePluginData<BacklinksPayload>("backlinks", {
    companyId,
    projectId,
    slug,
  });

  if (error !== null) {
    return (
      <section className="llm-wiki-backlinks llm-wiki-backlinks-error">
        <h3>Backlinks</h3>
        <p className="llm-wiki-error">Error: {error.message}</p>
      </section>
    );
  }
  if (loading || data === null) {
    return (
      <section className="llm-wiki-backlinks llm-wiki-backlinks-loading">
        <h3>Backlinks</h3>
        <p className="llm-wiki-empty">Loading…</p>
      </section>
    );
  }
  if (data.results.length === 0) {
    return (
      <section className="llm-wiki-backlinks llm-wiki-backlinks-empty">
        <h3>Backlinks</h3>
        <p className="llm-wiki-empty">No pages link here yet.</p>
      </section>
    );
  }
  return (
    <section className="llm-wiki-backlinks">
      <h3>Backlinks</h3>
      <ul>
        {data.results.map((r) => (
          <li key={r.slug}>
            <HostLink
              href={wikiHref(companyPrefix, { kind: "page", slug: r.slug })}
              data-wiki-slug={r.slug}
              title={r.snippet}
            >
              {r.title}
            </HostLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
