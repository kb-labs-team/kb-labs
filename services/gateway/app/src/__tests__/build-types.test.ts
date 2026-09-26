import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * server.ts declares `schema: { tags, summary }` on routes, which only
 * type-checks when the @fastify/swagger augmentation is loaded. The tsup DTS
 * build compiles from its entries, so the augmentation must be declared in
 * the build tsconfig instead of leaking in through whichever files happen to
 * be reachable (adding the bin entry broke that implicit path).
 */
describe("tsconfig.build.json", () => {
  it("loads the @fastify/swagger type augmentation explicitly", () => {
    const raw = readFileSync(
      new URL("../../tsconfig.build.json", import.meta.url),
      "utf8",
    );
    const config = JSON.parse(raw) as {
      compilerOptions?: { types?: string[] };
    };
    expect(config.compilerOptions?.types).toContain("@fastify/swagger");
  });
});
