/**
 * Baseline stylesheet for the wiki UI surfaces.
 *
 * Injected once into document.head on first slot mount. The host doesn't
 * ship a shared component kit (per the SDK README), so the plugin is on
 * the hook for its own visual hierarchy. We keep the styles minimal —
 * layout + spacing + a small badge — and rely on the host's typography
 * and colors via inherit / currentColor / transparent. This means the
 * plugin tracks the host theme automatically (light, dark, custom)
 * without theming declarations of its own.
 *
 * All selectors are namespaced under `.llm-wiki-*` so they cannot leak
 * into the host's UI.
 */

let injected = false;

const STYLE_ELEMENT_ID = "llm-wiki-plugin-styles";

const WIKI_STYLES = `
.llm-wiki-browser,
.llm-wiki-context-tab,
.llm-wiki-health,
.llm-wiki-page {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  font-size: inherit;
  color: inherit;
  line-height: 1.45;
  padding: 0.75rem;
  box-sizing: border-box;
}

.llm-wiki-browser-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.llm-wiki-search-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  font: inherit;
  opacity: 0.95;
}
.llm-wiki-search-input::placeholder {
  opacity: 0.55;
}
.llm-wiki-search-input:focus {
  outline: 2px solid currentColor;
  outline-offset: -2px;
  opacity: 1;
}

.llm-wiki-back {
  padding: 0.3rem 0.55rem;
  border-radius: 6px;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  opacity: 0.85;
}
.llm-wiki-back:hover { opacity: 1; }

/* Page list grouped by frontmatter type (sidebar default view). */
.llm-wiki-index {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}
.llm-wiki-index section {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.llm-wiki-index h3 {
  margin: 0;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.55;
}
.llm-wiki-index ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.llm-wiki-index li > button,
.llm-wiki-results > li > button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.35rem 0.5rem;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.llm-wiki-index li > button:hover,
.llm-wiki-results > li > button:hover,
.llm-wiki-result-link:hover {
  background: rgba(127, 127, 127, 0.12);
}

/* Search results + issue context list — flat list with title + type badge. */
.llm-wiki-results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.llm-wiki-results > li > button,
.llm-wiki-result-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}
.llm-wiki-result-link {
  text-decoration: none;
  color: inherit;
  padding: 0.45rem 0.6rem;
  border-radius: 4px;
}
.llm-wiki-result-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.llm-wiki-result-type,
.llm-wiki-type-badge {
  flex: 0 0 auto;
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 0.7rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.65;
  background: transparent;
  color: inherit;
}

/* Empty / loading / error states. */
.llm-wiki-empty,
.llm-wiki-error,
.llm-wiki-hint {
  margin: 0;
  opacity: 0.7;
  font-size: 0.9rem;
}

/* Health card. */
.llm-wiki-health header {
  font-weight: 600;
  font-size: 0.95rem;
}
.llm-wiki-health-stats {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 0.75rem;
  row-gap: 0.25rem;
  margin: 0;
}
.llm-wiki-health-stats dt {
  opacity: 0.6;
  font-size: 0.85rem;
}
.llm-wiki-health-stats dd {
  margin: 0;
  font-size: 0.95rem;
}
.llm-wiki-status-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border: 1px solid currentColor;
}
.llm-wiki-status-badge[data-lint-status="pass"] {
  border-color: rgba(0, 160, 80, 0.5);
  background: rgba(0, 160, 80, 0.12);
}
.llm-wiki-status-badge[data-lint-status="warn"] {
  border-color: rgba(200, 140, 0, 0.5);
  background: rgba(200, 140, 0, 0.12);
}
.llm-wiki-status-badge[data-lint-status="fail"] {
  border-color: rgba(200, 60, 60, 0.5);
  background: rgba(200, 60, 60, 0.12);
}
.llm-wiki-scaling-messages {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.85rem;
  opacity: 0.8;
}

/* Markdown page view. */
.llm-wiki-page header {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  margin-bottom: 0.5rem;
}
.llm-wiki-page h1 {
  margin: 0;
  font-size: 1.2rem;
}
.llm-wiki-page p { margin: 0.5rem 0; }
.llm-wiki-page h2 { margin: 1rem 0 0.4rem; font-size: 1.05rem; }
.llm-wiki-page h3 { margin: 0.85rem 0 0.3rem; font-size: 0.95rem; }
.llm-wiki-page code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.88em;
  background: rgba(127, 127, 127, 0.15);
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
}
.llm-wiki-page pre {
  background: rgba(127, 127, 127, 0.1);
  padding: 0.6rem;
  border-radius: 4px;
  overflow: auto;
}
.llm-wiki-page pre code {
  background: none;
  padding: 0;
}
.llm-wiki-page table {
  border-collapse: collapse;
  margin: 0.5rem 0;
}
.llm-wiki-page th,
.llm-wiki-page td {
  padding: 0.3rem 0.6rem;
  border: 1px solid rgba(127, 127, 127, 0.3);
}
.llm-wiki-page a[data-wiki-slug] {
  color: inherit;
  text-decoration: underline;
  text-decoration-style: dotted;
  cursor: pointer;
}

/* Sidebar launcher. */
.llm-wiki-launcher {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  padding: 0.6rem;
  font-size: inherit;
  color: inherit;
  box-sizing: border-box;
}
.llm-wiki-launcher-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.llm-wiki-launcher-title {
  font-weight: 600;
  font-size: 0.95rem;
}
.llm-wiki-launcher-open {
  color: inherit;
  text-decoration: none;
  opacity: 0.75;
  font-size: 0.85rem;
}
.llm-wiki-launcher-open:hover { opacity: 1; }
.llm-wiki-launcher-search { margin: 0; }
.llm-wiki-launcher-section h3 {
  margin: 0 0 0.3rem;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.55;
}
.llm-wiki-launcher-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
}
.llm-wiki-launcher-list a {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.3rem 0.45rem;
  border-radius: 4px;
  color: inherit;
  text-decoration: none;
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.llm-wiki-launcher-list a:hover { background: rgba(127, 127, 127, 0.12); }
.llm-wiki-launcher-type { flex: 1 1 auto; }
.llm-wiki-launcher-count { flex: 0 0 auto; opacity: 0.55; }
.llm-wiki-launcher-health {
  font-size: 0.75rem;
  opacity: 0.7;
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.llm-wiki-launcher-setup-cta {
  display: block;
  text-align: center;
  padding: 0.55rem 0.7rem;
  border-radius: 6px;
  border: 1px solid currentColor;
  text-decoration: none;
  color: inherit;
  font-size: 0.85rem;
  opacity: 0.85;
}
.llm-wiki-launcher-setup-cta:hover { opacity: 1; }

/* Three-column workspace (page slot). */
.llm-wiki-workspace {
  display: grid;
  grid-template-columns: minmax(200px, 240px) minmax(0, 1fr) minmax(220px, 280px);
  gap: 0.75rem;
  height: 100%;
  min-height: 0;
  padding: 0.75rem;
  box-sizing: border-box;
  font-size: inherit;
  color: inherit;
}
@media (max-width: 1100px) {
  .llm-wiki-workspace { grid-template-columns: minmax(200px, 240px) minmax(0, 1fr); }
  .llm-wiki-workspace-right { display: none; }
}
@media (max-width: 720px) {
  .llm-wiki-workspace { grid-template-columns: 1fr; }
  .llm-wiki-workspace-left { display: none; }
}
.llm-wiki-workspace-left,
.llm-wiki-workspace-right {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  overflow-y: auto;
  min-width: 0;
}
.llm-wiki-workspace-center {
  overflow-y: auto;
  min-width: 0;
  padding: 0 0.25rem;
}

/* Folder tree. */
.llm-wiki-tree,
.llm-wiki-tree-children {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
}
.llm-wiki-tree-children {
  padding-left: 0.85rem;
  margin-top: 0.05rem;
  border-left: 1px solid rgba(127, 127, 127, 0.18);
}
.llm-wiki-tree-folder-header {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  padding: 0.25rem 0.4rem;
  border-radius: 4px;
  cursor: pointer;
}
.llm-wiki-tree-folder-header:hover {
  background: rgba(127, 127, 127, 0.12);
}
.llm-wiki-tree-folder-caret {
  flex: 0 0 auto;
  font-size: 0.65rem;
  opacity: 0.55;
  width: 0.8rem;
  display: inline-block;
}
.llm-wiki-tree-folder-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85rem;
}
.llm-wiki-tree-link {
  display: block;
  padding: 0.25rem 0.4rem 0.25rem 1.1rem;
  border-radius: 4px;
  color: inherit;
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85rem;
}
.llm-wiki-tree-link:hover {
  background: rgba(127, 127, 127, 0.12);
}
.llm-wiki-tree-link-current {
  background: rgba(127, 127, 127, 0.18);
  font-weight: 600;
}

/* Right-rail panels. */
.llm-wiki-properties h3,
.llm-wiki-outline h3,
.llm-wiki-backlinks h3 {
  margin: 0 0 0.35rem;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.55;
}
.llm-wiki-properties dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 0.6rem;
  row-gap: 0.2rem;
  margin: 0;
  font-size: 0.85rem;
}
.llm-wiki-properties dt {
  opacity: 0.6;
  font-weight: 500;
}
.llm-wiki-properties dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.llm-wiki-outline ul,
.llm-wiki-backlinks ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  font-size: 0.85rem;
}
.llm-wiki-outline a,
.llm-wiki-backlinks a {
  color: inherit;
  text-decoration: none;
  padding: 0.2rem 0.3rem;
  border-radius: 3px;
  display: block;
}
.llm-wiki-outline a:hover,
.llm-wiki-backlinks a:hover {
  background: rgba(127, 127, 127, 0.12);
}
.llm-wiki-outline li[data-level="3"] { padding-left: 0.7rem; opacity: 0.85; }
.llm-wiki-outline li[data-level="4"] { padding-left: 1.2rem; opacity: 0.75; }
.llm-wiki-outline li[data-level="5"],
.llm-wiki-outline li[data-level="6"] { padding-left: 1.6rem; opacity: 0.65; }

/* Reader landing / folder / search views. */
.llm-wiki-landing,
.llm-wiki-folder-view,
.llm-wiki-search-view,
.llm-wiki-setup {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.25rem;
}
.llm-wiki-landing-index {
  font-size: inherit;
  color: inherit;
  line-height: 1.45;
}
.llm-wiki-landing-index h1 { font-size: 1.2rem; margin: 0 0 0.6rem; }
.llm-wiki-landing-index h2 { font-size: 1rem;  margin: 0.6rem 0 0.3rem; }
.llm-wiki-folder-view header h2,
.llm-wiki-search-view header h2,
.llm-wiki-setup h2 { margin: 0; font-size: 1.05rem; }

/* Permalink anchors next to headings (rehype-autolink-headings). */
.llm-wiki-page h1 .icon-link,
.llm-wiki-page h2 .icon-link,
.llm-wiki-page h3 .icon-link {
  display: none;
}
.llm-wiki-page h1:hover a[aria-hidden],
.llm-wiki-page h2:hover a[aria-hidden],
.llm-wiki-page h3:hover a[aria-hidden] {
  opacity: 0.5;
}
.llm-wiki-page h1 a[aria-hidden],
.llm-wiki-page h2 a[aria-hidden],
.llm-wiki-page h3 a[aria-hidden] {
  margin-left: 0.3rem;
  text-decoration: none;
  opacity: 0;
  color: inherit;
  font-size: 0.85em;
}

/* highlight.js minimal palette — currentColor / opacity-driven so it
   tracks the host theme rather than baking a single light/dark palette. */
.hljs           { background: rgba(127, 127, 127, 0.08); color: inherit; }
.hljs-comment,
.hljs-quote     { opacity: 0.55; font-style: italic; }
.hljs-keyword,
.hljs-selector-tag,
.hljs-built_in  { font-weight: 600; }
.hljs-string,
.hljs-attr,
.hljs-name      { opacity: 0.85; }
.hljs-number,
.hljs-literal,
.hljs-symbol,
.hljs-bullet    { opacity: 0.75; }

/* Error boundary. */
.llm-wiki-error-boundary {
  padding: 0.75rem;
  border: 1px solid rgba(200, 60, 60, 0.5);
  background: rgba(200, 60, 60, 0.08);
  border-radius: 4px;
  font-size: 0.9rem;
}
.llm-wiki-error-message {
  margin-top: 0.3rem;
  opacity: 0.75;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
}
`;

export function injectWikiStyles(): void {
  if (typeof document === "undefined") return;
  if (injected) return;
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) {
    injected = true;
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = WIKI_STYLES;
  document.head.appendChild(style);
  injected = true;
}
