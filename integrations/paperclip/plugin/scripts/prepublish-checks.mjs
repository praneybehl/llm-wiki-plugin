#!/usr/bin/env node
/**
 * Pre-publish checks for paperclip-plugin-llm-wiki.
 *
 * Mirrors SPEC §"Build and release" / FEASIBILITY §"What's left for human action".
 * Runs typecheck, tests, build, then walks every machine-checkable contract
 * the publish tarball must satisfy: package.json fields, manifest validator
 * acceptance, slot/capability gating (per Issue #2276 + FEASIBILITY §3),
 * UI bundle named exports, secrets scan, tarball contents, doc cross-refs,
 * CHANGELOG entry.
 *
 * Run:
 *   pnpm run prepublish:check          (full)
 *   pnpm run prepublish:check --fast   (skip rebuild + tests; reuse dist/)
 *
 * Exits non-zero on any failure. Used as the publish gate before
 * `pnpm publish` and as a CI step that catches drift introduced after
 * the previous publish.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const REPO_ROOT = resolve(ROOT, "../../..");
process.chdir(ROOT);

const args = new Set(process.argv.slice(2));
const FAST = args.has("--fast");

const colors = process.stdout.isTTY
  ? {
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
    }
  : {
      bold: (s) => s,
      green: (s) => s,
      red: (s) => s,
      yellow: (s) => s,
      dim: (s) => s,
    };

let pass = 0;
let fail = 0;
let warn = 0;
const failures = [];

const ok = (msg) => {
  console.log(`  ${colors.green("✓")} ${msg}`);
  pass++;
};
const bad = (msg) => {
  console.log(`  ${colors.red("✗")} ${msg}`);
  fail++;
  failures.push(msg);
};
const note = (msg) => {
  console.log(`  ${colors.yellow("⚠")} ${msg}`);
  warn++;
};
const section = (n, t) => console.log(`\n${colors.bold(`${n}. ${t}`)}`);

function runCommand(label, cmd) {
  try {
    execSync(cmd, { stdio: "pipe" });
    ok(label);
  } catch (e) {
    const tail = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
    bad(`${label} (exit ${e.status})`);
    if (tail.trim()) console.log(colors.dim(tail.trim().split("\n").slice(-8).map((l) => `      ${l}`).join("\n")));
  }
}

// ─── 1. Source quality ───────────────────────────────────────────────
section(1, "TypeScript typecheck");
if (FAST) note("--fast: skipped");
else runCommand("tsc --noEmit", "pnpm typecheck");

section(2, "Tests (lib parity + worker harness + UI rendering)");
if (FAST) note("--fast: skipped");
else runCommand("vitest run", "pnpm test");

// ─── 3-5. Build ──────────────────────────────────────────────────────
section(3, "Clean rebuild from rm -rf dist");
if (FAST) note("--fast: reusing existing dist/");
else {
  execSync("rm -rf dist", { stdio: "pipe" });
  runCommand("esbuild build", "pnpm run build");
}

section(4, "Built artifacts present at expected paths");
for (const p of ["dist/manifest.js", "dist/worker.js", "dist/ui/index.js"]) {
  existsSync(p) ? ok(p) : bad(`${p} missing`);
}

section(5, "Built artifacts are syntactically valid ESM");
for (const p of ["dist/manifest.js", "dist/worker.js", "dist/ui/index.js"]) {
  if (existsSync(p)) runCommand(`node --check ${p}`, `node --check ${p}`);
}

// ─── 6. package.json publishing contract ─────────────────────────────
section(6, "package.json publishing contract");
const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const pkgChecks = [
  ["name === paperclip-plugin-llm-wiki", pkg.name === "paperclip-plugin-llm-wiki"],
  ["version uses semver", /^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(pkg.version ?? "")],
  ["type === 'module'", pkg.type === "module"],
  ['files[] includes "dist"', Array.isArray(pkg.files) && pkg.files.includes("dist")],
  ['files[] includes "package.json"', Array.isArray(pkg.files) && pkg.files.includes("package.json")],
  ["paperclipPlugin.manifest === ./dist/manifest.js", pkg.paperclipPlugin?.manifest === "./dist/manifest.js"],
  ["paperclipPlugin.worker === ./dist/worker.js", pkg.paperclipPlugin?.worker === "./dist/worker.js"],
  ["paperclipPlugin.ui === ./dist/ui/", pkg.paperclipPlugin?.ui === "./dist/ui/"],
  [
    "peerDeps.@paperclipai/plugin-sdk pinned to a calver",
    /^\d{4}\.\d+\.\d+(-[\w.]+)?$/.test(pkg.peerDependencies?.["@paperclipai/plugin-sdk"] ?? ""),
  ],
  ["peerDeps.react is >=18", pkg.peerDependencies?.react === ">=18"],
  ["license: MIT", pkg.license === "MIT"],
];
for (const [label, c] of pkgChecks) (c ? ok : bad)(label);

// ─── 7. Manifest acceptance + key fields ─────────────────────────────
section(7, "Manifest validation against the SDK");
const manifestModule = await import(join(ROOT, "dist/manifest.js"));
const manifest = manifestModule.default ?? manifestModule;

try {
  const { createTestHarness } = await import("@paperclipai/plugin-sdk/testing");
  createTestHarness({ manifest });
  ok("createTestHarness({ manifest }) accepts the built manifest");
} catch (e) {
  bad(`SDK validator rejected manifest: ${e.message}`);
}

manifest.apiVersion === 1 ? ok("apiVersion === 1") : bad(`apiVersion is ${manifest.apiVersion}`);
manifest.sdkVersion === undefined
  ? ok("sdkVersion absent (validator does not check it)")
  : bad("sdkVersion declared — drop it");
Array.isArray(manifest.categories) && manifest.categories.length > 0
  ? ok(`categories: ${JSON.stringify(manifest.categories)}`)
  : bad("categories must be a non-empty array");
manifest.version === pkg.version
  ? ok(`manifest.version === package.json version (${pkg.version})`)
  : bad(`manifest.version (${manifest.version}) !== package.json version (${pkg.version})`);

// ─── 8. Slot/tool/capability gating ──────────────────────────────────
section(8, "Slot/tool/capability gating (FEASIBILITY §3 + Issue #2276)");
const UI_SLOT_CAPABILITIES = {
  sidebar: "ui.sidebar.register",
  sidebarPanel: "ui.sidebar.register",
  projectSidebarItem: "ui.sidebar.register",
  page: "ui.page.register",
  detailTab: "ui.detailTab.register",
  taskDetailView: "ui.detailTab.register",
  dashboardWidget: "ui.dashboardWidget.register",
  globalToolbarButton: "ui.action.register",
  toolbarButton: "ui.action.register",
  contextMenuItem: "ui.action.register",
  commentContextMenuItem: "ui.action.register",
  commentAnnotation: "ui.commentAnnotation.register",
  settingsPage: "instance.settings.register",
};
const slots = manifest.ui?.slots ?? [];
const slotIds = slots.map((s) => s.id);
new Set(slotIds).size === slotIds.length
  ? ok(`${slotIds.length} unique slot id(s)`)
  : bad("duplicate slot ids");

for (const slot of slots) {
  const required = UI_SLOT_CAPABILITIES[slot.type];
  if (!required) {
    bad(`slot ${slot.id} has unknown type ${slot.type}`);
  } else if (manifest.capabilities.includes(required)) {
    ok(`slot ${slot.id} (${slot.type}) → ${required}`);
  } else {
    bad(`slot ${slot.id} (${slot.type}) missing capability ${required}`);
  }
}

const tools = manifest.tools ?? [];
if (tools.length > 0 && !manifest.capabilities.includes("agent.tools.register")) {
  bad("tools[] declared but agent.tools.register is missing");
} else if (tools.length > 0) {
  ok(`${tools.length} tool(s) gated by agent.tools.register`);
}
for (const tool of tools) {
  if (!tool.parametersSchema || tool.parametersSchema.type !== "object") {
    bad(`tool ${tool.name} missing/invalid parametersSchema`);
  } else {
    ok(`tool ${tool.name} has object parametersSchema`);
  }
}

if ((manifest.jobs ?? []).length > 0 && !manifest.capabilities.includes("jobs.schedule")) {
  bad("jobs[] declared but jobs.schedule is missing");
}
if ((manifest.webhooks ?? []).length > 0 && !manifest.capabilities.includes("webhooks.receive")) {
  bad("webhooks[] declared but webhooks.receive is missing");
}

const writeCaps = manifest.capabilities.filter((c) =>
  /\.(write|create|update|delete)$/.test(c),
);
writeCaps.length === 0
  ? ok("no write capabilities declared (plugin is read-only by contract)")
  : bad(`unexpected write capabilities: ${writeCaps.join(", ")}`);

// ─── 9. UI bundle exports ─────────────────────────────────────────────
section(9, "UI bundle exposes the named exports the manifest references");
try {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const ui = await import(join(ROOT, "dist/ui/index.js"));
  for (const slot of slots) {
    typeof ui[slot.exportName] === "function"
      ? ok(`export ${slot.exportName} (used by slot ${slot.id})`)
      : bad(`export ${slot.exportName} is ${typeof ui[slot.exportName]}`);
  }
} catch (e) {
  bad(`failed to import dist/ui/index.js under jsdom: ${e.message}`);
}

// ─── 10. UI externals ────────────────────────────────────────────────
section(10, "UI bundle externalizes host-provided runtime");
const uiSource = readFileSync(join(ROOT, "dist/ui/index.js"), "utf-8");
const expectedExternals = [
  "react",
  "react/jsx-runtime",
  "@paperclipai/plugin-sdk/ui",
];
for (const ext of expectedExternals) {
  uiSource.includes(`"${ext}"`)
    ? ok(`'${ext}' is referenced (externalized)`)
    : note(`'${ext}' not found — may be unused`);
}
/React\.createElement\s*=\s*function/.test(uiSource)
  ? bad("React appears to be bundled inline")
  : ok("React not inlined into UI bundle");

// ─── 11. No secrets in dist ──────────────────────────────────────────
section(11, "Credential-shaped strings absent from dist/");
const SECRETS = [
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{36,}/,
  /\bsk-[A-Za-z0-9]{32,}/,
  /BEGIN RSA PRIVATE/,
  /BEGIN OPENSSH PRIVATE/,
  /BEGIN EC PRIVATE/,
];
const distFiles = execSync('find dist -type f -name "*.js"', { encoding: "utf-8" })
  .trim()
  .split("\n")
  .filter(Boolean);
let secretHit = 0;
for (const f of distFiles) {
  const content = readFileSync(f, "utf-8");
  for (const re of SECRETS) {
    if (re.test(content)) {
      bad(`${f} matches credential pattern ${re}`);
      secretHit++;
    }
  }
}
if (secretHit === 0) ok("no credential patterns matched in built artifacts");

// ─── 12. Tarball contents ────────────────────────────────────────────
section(12, "Publish tarball");
const packOutput = execSync("pnpm exec npm pack --dry-run 2>&1", {
  encoding: "utf-8",
});
const tarballFiles = [
  ...packOutput.matchAll(/^npm notice\s+[\d.]+\s*[kKmMgG]?B\s+(.+)$/gm),
].map((m) => m[1].trim());
const REQUIRED = [
  "README.md",
  "package.json",
  "dist/manifest.js",
  "dist/worker.js",
  "dist/ui/index.js",
];
for (const r of REQUIRED) {
  tarballFiles.includes(r)
    ? ok(`tarball contains ${r}`)
    : bad(`tarball missing ${r}`);
}
const ALLOWED_EXTRA = (f) =>
  REQUIRED.includes(f) ||
  f.endsWith(".map") ||
  f === "LICENSE" ||
  f.endsWith(".d.ts");
const surprises = tarballFiles.filter((f) => !ALLOWED_EXTRA(f));
if (surprises.length === 0) ok("no surprise files (artifacts + sourcemaps + LICENSE only)");
else for (const s of surprises) bad(`unexpected entry in tarball: ${s}`);

const sizeMatch = packOutput.match(/package size:\s+([\d.]+\s*[kMG]B)/);
if (sizeMatch) ok(`tarball size: ${sizeMatch[1]}`);

// ─── 13. Documentation + CHANGELOG ───────────────────────────────────
section(13, "Documentation cross-references and CHANGELOG entry");
for (const p of [
  "../SPEC.md",
  "../FEASIBILITY.md",
  "../README.md",
  "./README.md",
]) {
  existsSync(p) ? ok(`${relative(ROOT, resolve(ROOT, p))} exists`) : bad(`${p} missing`);
}
const changelogPath = join(REPO_ROOT, "CHANGELOG.md");
if (existsSync(changelogPath)) {
  const changelog = readFileSync(changelogPath, "utf-8");
  const releaseMarker = "`paperclip-plugin-llm-wiki` v" + pkg.version;
  changelog.includes(releaseMarker)
    ? ok(`CHANGELOG mentions ${releaseMarker}`)
    : bad(`CHANGELOG does not mention ${releaseMarker}`);
} else {
  bad("CHANGELOG.md not found at repo root");
}

section(14, "Setup snippets in sync with skills/llm-wiki canonical sources");
try {
  execSync("node ./scripts/check-setup-snippets.mjs", { stdio: "pipe" });
  ok("HEARTBEAT_STANZA in src/ui/setup/snippets.ts matches the canonical source");
} catch (e) {
  const stderr = e?.stderr?.toString?.() ?? String(e);
  bad(`setup snippets drift detected:\n${stderr.split("\n").slice(0, 6).join("\n")}`);
}

// ─── Final summary ───────────────────────────────────────────────────
console.log("\n" + "─".repeat(64));
const total = pass + fail;
const summary = `${pass}/${total} pass${warn > 0 ? `, ${warn} warning(s)` : ""}${
  fail > 0 ? `, ${colors.red(`${fail} failure(s)`)}` : ""
}`;
console.log(`  ${summary}`);
if (fail > 0) {
  console.log("\n  " + colors.red("Failures:"));
  for (const f of failures) console.log(`    - ${f}`);
  console.log("\n  Fix the above before running `pnpm publish`.");
  process.exit(1);
}
console.log(
  "\n  " + colors.green("✓ Pre-publish checks passed."),
);
console.log(
  "  Remaining (manual): smoke-test against a Paperclip instance with a populated wiki, then `pnpm publish`.",
);
