import { describe, expect, it } from "vitest";
import { selectManagedAdapterUpdateIds, serializeManagedGenerationFailure } from "./managed-generation-mutation.js";
import { parseManagedGenerationMutation } from "./managed-generation-request.js";

describe("managed Marketplace mutation boundary", () => {
  it("accepts only bounded install and adapter update data", () => {
    expect(parseManagedGenerationMutation({ operation: "install", specs: ["@kb-labs/commit@1.2.3"], dev: false }))
      .toEqual({ operation: "install", specs: ["@kb-labs/commit@1.2.3"] });
    expect(parseManagedGenerationMutation({ operation: "install", specs: ["@kb-labs/commit@1.2.3"] }))
      .toEqual({ operation: "install", specs: ["@kb-labs/commit@1.2.3"] });
    expect(parseManagedGenerationMutation({ operation: "update", packageIds: ["@kb-labs/sample-adapter"] }))
      .toEqual({ operation: "update", packageIds: ["@kb-labs/sample-adapter"] });
    expect(parseManagedGenerationMutation({ operation: "update" }))
      .toEqual({ operation: "update" });
  });

  it("updates npm-backed pins by default and rejects explicitly selected Registry pins", () => {
    const lock = { adapters: {
      "@kb-labs/npm-adapter": { source: "marketplace", marketplaceSource: "npm" },
      "@kb-labs/registry-adapter": { source: "marketplace", marketplaceSource: "registry" },
    } };
    expect(selectManagedAdapterUpdateIds(lock)).toEqual(["@kb-labs/npm-adapter"]);
    expect(() => selectManagedAdapterUpdateIds(lock, ["@kb-labs/registry-adapter"]))
      .toThrow(/npm-backed adapters only/);
  });

  it("emits bounded typed helper diagnostics with referenced secrets redacted", () => {
    const error = Object.assign(new Error(`registry rejected token fixture-secret ${"x".repeat(3000)}`), {
      code: "KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING",
      hint: "restore fixture-secret and retry",
    });
    const diagnostic = JSON.parse(serializeManagedGenerationFailure(error, ["fixture-secret"])) as { schema: number; code: string; message: string; hint: string };
    expect(diagnostic).toMatchObject({
      schema: 1,
      code: "KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING",
      hint: "restore [redacted] and retry",
    });
    expect(diagnostic.message).toContain("[redacted]");
    expect(diagnostic.message).not.toContain("fixture-secret");
    expect(diagnostic.message.length).toBeLessThanOrEqual(2048);
  });

  it("rejects roots, environment, arbitrary scope, handlers and oversized requests", () => {
    for (const request of [
      { operation: "install", specs: ["@kb-labs/commit@1.2.3"], root: "/tmp/other" },
      { operation: "install", specs: ["@kb-labs/commit@1.2.3"], scope: "project" },
      { operation: "install", specs: ["@kb-labs/commit@1.2.3"], env: { KB_PLATFORM_ROOT: "/tmp/other" } },
      { operation: "install", specs: ["@kb-labs/commit@1.2.3"], permissions: ["*" ] },
      { operation: "uninstall", packageIds: ["@kb-labs/commit"] },
      { operation: "update", packageIds: ["@kb-labs/commit", "@kb-labs/commit"] },
      { operation: "update", packageIds: [] },
      { operation: "update", packageIds: null },
      { operation: "update", packageIds: ["@kb-labs/commit@1.2.3"] },
      { operation: "install", specs: Array.from({ length: 33 }, () => "@kb-labs/commit@1.2.3") },
    ]) expect(() => parseManagedGenerationMutation(request)).toThrow();
  });
});
