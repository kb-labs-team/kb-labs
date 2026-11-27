import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runService, requireEnvironmentSecret } = vi.hoisted(() => ({ runService: vi.fn(), requireEnvironmentSecret: vi.fn() }));

vi.mock("@kb-labs/shared-daemon", () => ({ runService, requireEnvironmentSecret }));

import { resolvePublicUrl } from "../server.js";
import { resolveGatewayStandaloneScope } from "../bootstrap.js";

describe("gateway entrypoints", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    runService.mockReset();
    requireEnvironmentSecret.mockReset();
  });

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

    expect(requireEnvironmentSecret).toHaveBeenCalledWith("GATEWAY_INTERNAL_SECRET");
    expect(runService).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "gateway",
        serviceId: "gateway",
        startDir: "/some/root",
        defaultPort: 4000,
        portEnvVar: "GATEWAY_PORT",
        defaultHost: "0.0.0.0",
        hostEnvVar: "GATEWAY_HOST",
        setup,
      }),
    );
  });

  it('keeps project scope by default and supports platform scope for standalone Gateway', async () => {
    expect(resolveGatewayStandaloneScope(undefined)).toEqual({
      projectScope: 'required',
      configScope: 'project',
    });
    expect(resolveGatewayStandaloneScope('platform')).toEqual({
      projectScope: 'platform',
      configScope: 'platform',
    });
    expect(() => resolveGatewayStandaloneScope('unknown')).toThrow('GATEWAY_PROJECT_SCOPE');

    const { bootstrap, setup } = await import('../index.js');
    vi.stubEnv('GATEWAY_PROJECT_SCOPE', 'platform');
    runService.mockResolvedValue(undefined);

    await bootstrap('/some/root');

    const options = runService.mock.calls[0]?.[0];
    expect(options.projectScope).toBe('platform');
    expect(options.setup).not.toBe(setup);
  });

  // case: S-038.1
  it('fails before starting when GATEWAY_INTERNAL_SECRET is missing', async () => {
    const { bootstrap } = await import('../index.js');
    requireEnvironmentSecret.mockImplementation(() => { throw new Error('KB_CONFIG_SECRET_MISSING: GATEWAY_INTERNAL_SECRET'); });

    await expect(bootstrap('/some/root')).rejects.toThrow('KB_CONFIG_SECRET_MISSING: GATEWAY_INTERNAL_SECRET');
    expect(runService).not.toHaveBeenCalled();
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
