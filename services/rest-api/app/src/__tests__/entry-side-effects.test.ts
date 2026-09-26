import { describe, expect, it, vi } from "vitest";

const runService = vi.hoisted(() => vi.fn());

vi.mock("@kb-labs/shared-daemon", () => ({ runService }));

describe("rest-api entrypoints", () => {
  it("importing the library entry does not start the service", async () => {
    const entry = await import("../index");

    expect(runService).not.toHaveBeenCalled();
    expect(typeof entry.bootstrap).toBe("function");
    expect(typeof entry.setup).toBe("function");
  });

  it("bootstrap delegates to runService with the exported setup", async () => {
    const { bootstrap, setup } = await import("../index");
    runService.mockResolvedValue(undefined);

    await bootstrap("/some/root");

    expect(runService).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "rest-api",
        serviceId: "rest",
        startDir: "/some/root",
        defaultPort: 5050,
        portEnvVar: "REST_API_PORT",
        setup,
      }),
    );
  });
});
