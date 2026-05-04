import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.{ts,tsx}"],
    // Default node environment for lib + worker tests. UI tests opt into
    // jsdom via `// @vitest-environment jsdom` at the top of each spec.
    environment: "node",
    // Enable global afterEach so @testing-library/react@16 auto-cleans the
    // jsdom container between tests. Without this, render() output from a
    // previous test bleeds into the next one (multi-element matches).
    globals: true,
  },
});
