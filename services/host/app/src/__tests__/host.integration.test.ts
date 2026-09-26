import { afterEach, describe, expect, it } from "vitest";
import { HostExposureRefusedError } from "../errors.js";
import {
  canBind,
  isPortListening,
  startTestHost,
  type RunningHost,
} from "./harness.js";

interface HealthBody {
  upstreams: Record<string, { status: string }>;
}

function portOf(url: string | undefined): number {
  if (!url) {throw new Error("missing internal url");}
  return Number(new URL(url).port);
}

describe("kb-host (one process, real launchPlatform, in-memory adapters)", () => {
  let running: RunningHost | undefined;

  afterEach(async () => {
    // stop() is idempotent, so a test that already stopped the host is fine.
    await running?.stop().catch(() => undefined);
    running = undefined;
  });

  it("serves the gateway on the configured port and proxies marketplace and state", async () => {
    running = await startTestHost();

    const health = await running.fetchGateway("/health");
    expect(health.status).toBe(200);
    const body = (await health.json()) as HealthBody;
    expect(body.upstreams.marketplace?.status).toBe("up");
    expect(body.upstreams.state?.status).toBe("up");

    const marketplace = await running.fetchGateway(
      "/api/v1/marketplace/packages",
    );
    expect(marketplace.status).toBe(200);

    const put = await running.fetchGateway("/api/v1/state/state/greeting", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "hello" }),
    });
    expect(put.status).toBe(204);
    const get = await running.fetchGateway("/api/v1/state/state/greeting");
    expect(get.status).toBe(200);
    expect(JSON.parse(await get.text())).toBe("hello");
  });

  it("keeps marketplace and state on distinct internal loopback ports", async () => {
    running = await startTestHost();

    const marketplaceUrl = running.internalUrl("marketplace");
    const stateUrl = running.internalUrl("state-daemon");
    expect(marketplaceUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(stateUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const ports = new Set([
      portOf(marketplaceUrl),
      portOf(stateUrl),
      running.gatewayPort,
    ]);
    expect(ports.size).toBe(3);
    // The internal modules answer directly on loopback, so the map is real.
    const direct = await fetch(`${marketplaceUrl}/health`);
    expect(direct.status).toBe(200);
  });

  it("stops every module on SIGTERM, exits 0 and releases all ports", async () => {
    running = await startTestHost();
    const ports = [
      running.gatewayPort,
      portOf(running.internalUrl("marketplace")),
      portOf(running.internalUrl("state-daemon")),
    ];
    for (const port of ports) {
      expect(await isPortListening(port)).toBe(true);
    }

    const exitCode = await running.stop();

    expect(exitCode).toBe(0);
    for (const port of ports) {
      expect(await isPortListening(port)).toBe(false);
      expect(await canBind(port)).toBe(true);
    }
  });

  it("runs only the modules listed in host.modules", async () => {
    running = await startTestHost({ host: { modules: ["gateway", "state"] } });

    const health = (await (
      await running.fetchGateway("/health")
    ).json()) as HealthBody;
    expect(health.upstreams.state?.status).toBe("up");
    expect(health.upstreams.marketplace).toBeUndefined();

    const marketplace = await running.fetchGateway(
      "/api/v1/marketplace/packages",
    );
    expect(marketplace.status).toBe(404);

    // The disabled module never bound its reserved port.
    expect(await isPortListening(portOf(running.internalUrl("marketplace")))).toBe(
      false,
    );
  });

  it("does not open the external port when the gateway is not selected", async () => {
    running = await startTestHost({ host: { modules: ["state"] } });

    expect(await isPortListening(running.gatewayPort)).toBe(false);
    const stateUrl = running.internalUrl("state-daemon");
    expect((await fetch(`${stateUrl}/health`)).status).toBe(200);
  });

  it("refuses to start with auth off and a non-loopback bind, before binding anything", async () => {
    let refusal: unknown;
    try {
      running = await startTestHost({
        host: { auth: "off" },
        gateway: { host: "0.0.0.0" },
      });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(HostExposureRefusedError);
    const envelope = (refusal as HostExposureRefusedError).envelope;
    expect(envelope.code).toBe("KB_HOST_EXPOSURE_REFUSED");
    expect(envelope.hint.length).toBeGreaterThan(0);
    expect(envelope.details).toEqual({ bindHost: "0.0.0.0" });
  });

  it("requires login on the gateway when host.auth is on", async () => {
    running = await startTestHost({ host: { auth: "on" } });

    const anonymous = await running.fetchGateway("/api/v1/marketplace/packages");
    expect(anonymous.status).toBe(401);
    // /health stays public.
    expect((await running.fetchGateway("/health")).status).toBe(200);
  });

  it("does not require login when host.auth is off (loopback only)", async () => {
    running = await startTestHost({ host: { auth: "off" } });

    const anonymous = await running.fetchGateway("/api/v1/marketplace/packages");
    expect(anonymous.status).toBe(200);
  });
});
