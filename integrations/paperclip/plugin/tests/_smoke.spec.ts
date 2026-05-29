import { describe, it, expect } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Phase 1 sanity test. Proves: vitest runs, the SDK's testing harness
 * imports cleanly, and a minimal manifest constructs a harness without
 * the host being attached. Real worker/data/tool tests come in Phase 4.
 */
describe("plugin sdk wiring", () => {
  it("createTestHarness constructs from a minimal manifest", () => {
    const manifest: PaperclipPluginManifestV1 = {
      id: "io.praneybehl.llm-wiki",
      apiVersion: 1,
      version: "0.0.1",
      displayName: "LLM Wiki",
      description: "Smoke-test manifest.",
      author: "Praney Behl",
      categories: ["workspace"],
      capabilities: ["projects.read"],
      entrypoints: { worker: "./dist/worker.js" },
    };

    const harness = createTestHarness({ manifest });

    expect(harness).toBeDefined();
    expect(harness.ctx).toBeDefined();
  });
});
