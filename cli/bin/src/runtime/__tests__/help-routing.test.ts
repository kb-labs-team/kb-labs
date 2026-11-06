import { describe, expect, it } from "vitest";
import type { RegisteredCommand } from "@kb-labs/cli-commands";
import { hasNestedCommands } from "../help-routing";

function command(segments: string[]): RegisteredCommand {
  return {
    manifest: {
      manifestVersion: "1.0",
      segments,
      id: segments.join(":"),
      group: segments[0]!,
      describe: segments.join(" "),
      loader: async () => ({ run: async () => 0 }),
    },
    available: true,
    source: "workspace",
    shadowed: false,
  };
}

describe("hasNestedCommands", () => {
  it("detects a command that is also a namespace", () => {
    expect(
      hasNestedCommands(["commit"], [
        command(["commit"]),
        command(["commit", "plan", "show"]),
      ]),
    ).toBe(true);
  });

  it("does not treat a leaf command as a namespace", () => {
    expect(
      hasNestedCommands(["commit", "plan", "show"], [
        command(["commit", "plan", "show"]),
      ]),
    ).toBe(false);
  });

  it("ignores commands from a different path", () => {
    expect(
      hasNestedCommands(["commit"], [
        command(["commit"]),
        command(["review", "open"]),
      ]),
    ).toBe(false);
  });
});
