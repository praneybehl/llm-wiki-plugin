#!/usr/bin/env node
// Verifies that the heartbeat stanza bundled into the plugin
// (src/ui/setup/snippets.ts) matches the canonical source in
// skills/llm-wiki/references/agent-memory-integration.md.
//
// Run as part of `pnpm prepublish:check` so a stanza edit in either
// place fails the build until both sides agree.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");

const STANZA_DOC = resolve(
  repoRoot,
  "skills/llm-wiki/references/agent-memory-integration.md",
);
const SNIPPETS_TS = resolve(here, "..", "src/ui/setup/snippets.ts");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/**
 * Extract the first fenced block under "## The canonical stanza".
 * The doc happens to put the canonical block right after that heading.
 */
function extractCanonicalStanza(docText) {
  const headingIdx = docText.indexOf("## The canonical stanza");
  if (headingIdx < 0) {
    fail(`could not find "## The canonical stanza" heading in ${STANZA_DOC}`);
  }
  const after = docText.slice(headingIdx);
  const fenceRe = /```markdown\n([\s\S]*?)\n```/;
  const m = after.match(fenceRe);
  if (!m || !m[1]) {
    fail(`no fenced markdown block under "## The canonical stanza"`);
  }
  return m[1];
}

/**
 * Pull the literal value of `HEARTBEAT_STANZA` out of snippets.ts. The
 * file is hand-written TypeScript with a single template literal that
 * spans multiple lines and uses `\`` to escape backticks inside. We
 * reconstruct the runtime string by un-escaping `\`` -> `` ` `` and
 * `\${` -> `${`.
 */
function extractStanzaFromSnippets(srcText) {
  const re =
    /export const HEARTBEAT_STANZA = `([\s\S]*?)`;\s*$/m;
  const m = srcText.match(re);
  if (!m || !m[1]) {
    fail(`could not find HEARTBEAT_STANZA template literal in ${SNIPPETS_TS}`);
  }
  return m[1].replace(/\\`/g, "`").replace(/\\\$\{/g, "${");
}

function main() {
  const docText = readFileSync(STANZA_DOC, "utf8");
  const snippetsSrc = readFileSync(SNIPPETS_TS, "utf8");

  const canonical = extractCanonicalStanza(docText).trim();
  const actual = extractStanzaFromSnippets(snippetsSrc).trim();

  if (canonical !== actual) {
    console.error("✗ HEARTBEAT_STANZA in snippets.ts has drifted from");
    console.error(`  ${STANZA_DOC}`);
    console.error("");
    console.error("  Canonical (first 200 chars):");
    console.error(`  ${JSON.stringify(canonical.slice(0, 200))}`);
    console.error("  Actual (first 200 chars):");
    console.error(`  ${JSON.stringify(actual.slice(0, 200))}`);
    console.error("");
    console.error(
      "  Resolve by copying the canonical block into HEARTBEAT_STANZA",
    );
    console.error("  in src/ui/setup/snippets.ts.");
    process.exit(1);
  }

  console.log(
    `✓ HEARTBEAT_STANZA matches ${STANZA_DOC.replace(repoRoot + "/", "")}`,
  );
}

main();
