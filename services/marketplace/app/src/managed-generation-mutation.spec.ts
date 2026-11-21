import { describe, expect, it } from "vitest";
import { parseManagedGenerationMutation } from "./managed-generation-request.js";

describe("managed Marketplace mutation boundary", () => {
  it("accepts only bounded platform mutation data", () => {
    expect(parseManagedGenerationMutation({ operation: "install", specs: ["@kb-labs/commit@1.2.3"], dev: false }))
      .toEqual({ operation: "install", specs: ["@kb-labs/commit@1.2.3"] });
    expect(parseManagedGenerationMutation({ operation: "disable", packageId: "@kb-labs/commit" }))
      .toEqual({ operation: "disable", packageId: "@kb-labs/commit" });
  });

  it("rejects roots, environment, arbitrary scope, handlers and oversized requests", () => {
    for (const request of [
      { operation: "install", specs: ["@kb-labs/commit@1.2.3"], root: "/tmp/other" },
      { operation: "install", specs: ["@kb-labs/commit@1.2.3"], scope: "project" },
      { operation: "install", specs: ["@kb-labs/commit@1.2.3"], env: { KB_PLATFORM_ROOT: "/tmp/other" } },
      { operation: "install", specs: ["@kb-labs/commit@1.2.3"], permissions: ["*" ] },
      { operation: "install", specs: Array.from({ length: 33 }, () => "@kb-labs/commit@1.2.3") },
    ]) expect(() => parseManagedGenerationMutation(request)).toThrow();
  });
});
