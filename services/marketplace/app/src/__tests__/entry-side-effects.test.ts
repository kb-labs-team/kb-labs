import { describe, expect, it, vi } from "vitest";

const runService = vi.hoisted(() => vi.fn());

vi.mock("@kb-labs/shared-daemon", () => ({ runService }));

describe("marketplace entrypoints", () => {
  it("importing the library entry does not start the service", async () => {
    const entry = await import("../index.js");

    expect(runService).not.toHaveBeenCalled();
    expect(typeof entry.bootstrap).toBe("function");
    expect(typeof entry.setup).toBe("function");
  });

  it("bootstrap delegates to runService with the exported setup", async () => {
    const { bootstrap, setup } = await import("../index.js");
    runService.mockResolvedValue(undefined);

    await bootstrap("/some/root");

    expect(runService).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "marketplace",
        startDir: "/some/root",
        defaultPort: 5070,
        portEnvVar: "KB_MARKETPLACE_PORT",
        setup,
      }),
    );
  });
});
