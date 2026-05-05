import * as React from "react";

/**
 * Properties panel — surfaces the page's frontmatter as a definition list.
 *
 * Excluded keys:
 *   - `title` — already shown as the page heading.
 *   - `body` — defensive; bodies live in the rendered article, not meta.
 *   - any nested object/array-of-objects — not useful as a key/value
 *     row. Plain string arrays are joined with commas.
 */

const HIDDEN_KEYS = new Set(["title", "body"]);

function renderValue(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const flat = v.filter(
      (item) => typeof item === "string" || typeof item === "number",
    );
    if (flat.length === 0) return null;
    return flat.join(", ");
  }
  return null;
}

export interface PropertiesPanelProps {
  meta: Record<string, unknown>;
}

export function PropertiesPanel({
  meta,
}: PropertiesPanelProps): React.ReactElement {
  const entries = Object.entries(meta)
    .filter(([k]) => !HIDDEN_KEYS.has(k))
    .map(([k, v]) => [k, renderValue(v)] as const)
    .filter((pair): pair is readonly [string, string] => pair[1] !== null)
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (entries.length === 0) {
    return (
      <section className="llm-wiki-properties llm-wiki-properties-empty">
        <h3>Properties</h3>
        <p className="llm-wiki-empty">No frontmatter on this page.</p>
      </section>
    );
  }

  return (
    <section className="llm-wiki-properties">
      <h3>Properties</h3>
      <dl>
        {entries.map(([key, value]) => (
          <React.Fragment key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  );
}
