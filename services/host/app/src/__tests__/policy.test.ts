import { describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "@kb-labs/gateway-contracts";
import { HostExposureRefusedError } from "../errors.js";
import { applyHostGatewayPolicy } from "../policy.js";
import { parseHostSettings } from "../settings.js";

const upstreams = {
  state: { serviceId: "state-daemon", prefix: "/api/v1/state", rewritePrefix: "" },
};

describe("applyHostGatewayPolicy", () => {
  it("forces local mode and loopback when auth is off and no host is set", () => {
    const result = applyHostGatewayPolicy(GatewayConfigSchema.parse({}), {
      auth: "off",
      upstreams,
    });
    expect(result.host).toBe("127.0.0.1");
    expect(result.access).toEqual({ mode: "local" });
    expect(result.upstreams.state).toEqual(upstreams.state);
  });

  it.each(["0.0.0.0", "192.168.1.10", "::", "example.test"])(
    "refuses auth off with a non-loopback bind (%s)",
    (host) => {
      const config = GatewayConfigSchema.parse({ host });
      let error: unknown;
      try {
        applyHostGatewayPolicy(config, { auth: "off", upstreams });
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(HostExposureRefusedError);
      expect((error as HostExposureRefusedError).envelope.code).toBe(
        "KB_HOST_EXPOSURE_REFUSED",
      );
    },
  );

  it.each(["127.0.0.1", "localhost", "::1"])(
    "accepts auth off on loopback (%s)",
    (host) => {
      const result = applyHostGatewayPolicy(GatewayConfigSchema.parse({ host }), {
        auth: "off",
        upstreams,
      });
      expect(result.host).toBe(host);
    },
  );

  it("allows a public bind when auth is on and leaves the host untouched", () => {
    const result = applyHostGatewayPolicy(
      GatewayConfigSchema.parse({ host: "0.0.0.0" }),
      { auth: "on", upstreams },
    );
    expect(result.host).toBe("0.0.0.0");
    expect(result.access).toEqual({ mode: "secured" });
  });

  it("lets configured upstreams win over generated ones by name", () => {
    const config = GatewayConfigSchema.parse({
      upstreams: { state: { serviceId: "custom", prefix: "/custom" } },
    });
    const result = applyHostGatewayPolicy(config, { auth: "off", upstreams });
    expect(result.upstreams.state).toEqual({
      serviceId: "custom",
      prefix: "/custom",
    });
  });

  it("rejects a gateway config that contradicts host.auth", () => {
    const enabled = GatewayConfigSchema.parse({ auth: { enabled: true } });
    expect(() =>
      applyHostGatewayPolicy(enabled, { auth: "off", upstreams }),
    ).toThrow(/host\.auth is "off"/);
    const disabled = GatewayConfigSchema.parse({ auth: { enabled: false } });
    expect(() =>
      applyHostGatewayPolicy(disabled, { auth: "on", upstreams }),
    ).toThrow(/host\.auth is "on"/);
  });
});

describe("parseHostSettings", () => {
  it("defaults to every module and auth off", () => {
    expect(parseHostSettings(undefined)).toEqual({
      modules: ["gateway", "marketplace", "state"],
      auth: "off",
    });
  });

  it("keeps the selected modules and removes duplicates", () => {
    expect(
      parseHostSettings({ modules: ["state", "state", "gateway"], auth: "on" }),
    ).toEqual({ modules: ["state", "gateway"], auth: "on" });
  });

  it.each([
    [{ modules: [] }, /host\.modules/],
    [{ modules: ["rest"] }, /host\.modules/],
    [{ auth: "maybe" }, /host\.auth/],
  ])("rejects invalid settings %j", (raw, message) => {
    expect(() => parseHostSettings(raw)).toThrow(message);
  });
});
