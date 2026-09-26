import { describe, expect, it, vi } from "vitest";
import type {
  IServiceTransport,
  ServiceTransportResponse,
} from "@kb-labs/core-platform";
import {
  createGeneratedTransport,
  HostServiceTransport,
  reserveLoopbackPorts,
} from "../transport.js";

const ok: ServiceTransportResponse = { ok: true, statusCode: 200 };

function configuredTransport(
  known: Record<string, string>,
): IServiceTransport & { close: ReturnType<typeof vi.fn> } {
  return {
    connectionInfo: (id) => (known[id] ? { baseUrl: known[id]! } : undefined),
    listenAddress: (id) =>
      known[id] ? { port: Number(new URL(known[id]!).port) } : undefined,
    call: vi.fn().mockResolvedValue(ok),
    stream: vi.fn(),
    close: vi.fn(),
  };
}

describe("reserveLoopbackPorts", () => {
  it("returns distinct free ports", async () => {
    const ports = await reserveLoopbackPorts(4);
    expect(new Set(ports).size).toBe(4);
    for (const port of ports) {
      expect(port).toBeGreaterThan(1023);
    }
  });
});

describe("HostServiceTransport", () => {
  it("generates loopback routes and bind addresses from the same map", () => {
    const transport = new HostServiceTransport(
      createGeneratedTransport({ marketplace: 41001, "state-daemon": 41002 }),
    );
    expect(transport.connectionInfo("marketplace")).toEqual({
      baseUrl: "http://127.0.0.1:41001",
      socketPath: undefined,
    });
    expect(transport.listenAddress("state-daemon")).toEqual({ port: 41002 });
    expect(transport.connectionInfo("rest")).toBeUndefined();
  });

  it("does not shift generated ports by KB_NET_OFFSET", () => {
    const previous = process.env.KB_NET_OFFSET;
    process.env.KB_NET_OFFSET = "100";
    try {
      const transport = new HostServiceTransport(
        createGeneratedTransport({ marketplace: 41001 }),
      );
      expect(transport.listenAddress("marketplace")).toEqual({ port: 41001 });
    } finally {
      if (previous === undefined) {delete process.env.KB_NET_OFFSET;}
      else {process.env.KB_NET_OFFSET = previous;}
    }
  });

  it("keeps an explicitly configured route authoritative", async () => {
    const configured = configuredTransport({
      marketplace: "http://127.0.0.1:41500",
      rest: "http://127.0.0.1:41501",
    });
    const transport = new HostServiceTransport(
      createGeneratedTransport({ marketplace: 41001, "state-daemon": 41002 }),
      configured,
    );

    // Explicit override wins for a host-run module and also binds there.
    expect(transport.connectionInfo("marketplace")?.baseUrl).toBe(
      "http://127.0.0.1:41500",
    );
    expect(transport.listenAddress("marketplace")).toEqual({ port: 41500 });
    // Services the host does not run stay routable through the configured map.
    expect(transport.connectionInfo("rest")?.baseUrl).toBe(
      "http://127.0.0.1:41501",
    );
    // The rest is generated.
    expect(transport.connectionInfo("state-daemon")?.baseUrl).toBe(
      "http://127.0.0.1:41002",
    );

    await transport.call("rest", { path: "/health" });
    expect(configured.call).toHaveBeenCalledWith("rest", { path: "/health" });
  });

  it("releases the generated pools on close", async () => {
    const generated = createGeneratedTransport({ marketplace: 41001 });
    const destroy = vi.spyOn(generated, "destroy");
    await new HostServiceTransport(generated).close();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
