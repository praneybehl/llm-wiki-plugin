/**
 * Build paperclip-plugin-llm-wiki using the SDK's bundler presets.
 *
 *   pnpm run build         → one-shot build
 *   pnpm run build:watch   → rebuild on change
 *
 * The presets externalize react / react-dom / react/jsx-runtime and the
 * SDK UI subpaths — the Paperclip host provides those at runtime through
 * its plugin bridge (FEASIBILITY §4 / SDK README External Dependencies).
 *
 * Outputs:
 *   dist/manifest.js  — manifest module the host validates at install time
 *   dist/worker.js    — worker entry, started as a child process by the host
 *   dist/ui/index.mjs — UI bundle exposing the named slot components
 *
 * The package.json `paperclipPlugin` field points at exactly these paths.
 */

import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const presets = createPluginBundlerPresets({
  pluginRoot: here,
  manifestEntry: "src/manifest.ts",
  workerEntry: "src/worker.ts",
  uiEntry: "src/ui/index.tsx",
  outdir: "dist",
  sourcemap: true,
  minify: false,
});

const watch = process.argv.includes("--watch");

const builds = [
  presets.esbuild.manifest,
  presets.esbuild.worker,
  ...(presets.esbuild.ui ? [presets.esbuild.ui] : []),
];

if (watch) {
  const ctxs = await Promise.all(builds.map((cfg) => esbuild.context(cfg)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("[esbuild] watching…");
} else {
  await Promise.all(builds.map((cfg) => esbuild.build(cfg)));
  console.log("[esbuild] built manifest + worker + ui");
}
