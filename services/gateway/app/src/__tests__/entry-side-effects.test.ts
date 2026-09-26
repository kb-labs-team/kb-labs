import { afterEach, describe, expect, it, vi } from "vitest";

const runService = vi.hoisted(() => vi.fn());

vi.mock("@kb-labs/shared-daemon", () => ({ runService }));

import { resolvePublicUrl } from "../server.js";

describe("gateway entrypoints", () => {
  it("importing the library entry does not start the service", async () => {
    const entry = await import("../index.js");

    expect(runService).not.toHaveBeenCalled();
    expect(typeof entry.bootstrap).toBe("function");
    expect(typeof entry.setup).toBe("function");
  });

  it("bootstrap delegates to runService with the gateway setup", async () => {
    const { bootstrap, setup } = await import("../index.js");
    runService.mockResolvedValue(undefined);

    await bootstrap("/some/root");

    expect(runService).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "gateway",
        startDir: "/some/root",
        defaultPort: 4000,
        portEnvVar: "GATEWAY_PORT",
        setup,
      }),
    );
  });
});

describe("resolvePublicUrl", () => {
  const original = process.env.GATEWAY_PUBLIC_URL;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.GATEWAY_PUBLIC_URL;
    } else {
      process.env.GATEWAY_PUBLIC_URL = original;
    }
  });

  it("derives a loopback URL from the resolved listen port", () => {
    delete process.env.GATEWAY_PUBLIC_URL;
    expect(resolvePublicUrl(4123)).toBe("http://localhost:4123");
  });

  it("prefers GATEWAY_PUBLIC_URL", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gw.example.test";
    expect(resolvePublicUrl(4123)).toBe("https://gw.example.test");
  });
});
