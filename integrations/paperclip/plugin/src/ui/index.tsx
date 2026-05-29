/**
 * Public exports for the UI bundle. Each named export here corresponds 1:1
 * with a `slots[].exportName` field in src/manifest.ts; the bundler
 * outputs ./dist/ui/index.mjs and the host loader looks up these names.
 *
 * Externals (set by createPluginBundlerPresets):
 *   - react, react-dom, react/jsx-runtime
 *   - @paperclipai/plugin-sdk/ui
 *   - @paperclipai/plugin-sdk/ui/hooks
 *
 * Per @paperclipai/plugin-sdk README, plugin UI bundles run as
 * same-origin JavaScript inside the Paperclip app. Treat this code as
 * trusted; do not call external APIs directly — all backend traffic
 * goes through usePluginData / usePluginAction.
 */

export { WikiSidebar } from "./WikiSidebar.js";
export { WikiPage } from "./WikiPage.js";
export { WikiContextTab } from "./WikiContextTab.js";
export { WikiHealthIndicator } from "./WikiHealthIndicator.js";
export { WikiPageView } from "./WikiPageView.js";
export { ErrorBoundary } from "./ErrorBoundary.js";
