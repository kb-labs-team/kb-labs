import { describe, expect, it, vi } from "vitest";
import { HttpServiceTransport } from "@kb-labs/adapters-service-transport-http";
import type { IServiceTransport } from "@kb-labs/core-platform";
import { RuntimeServiceTransport } from "../transport.js";

function configured(known: Record<string, string>): IServiceTransport {
  return {
    connectionInfo: (id) => (known[id] ? { baseUrl: known[id]! } : undefined),
    listenAddress: (id) =>
      known[id] ? { port: Number(new URL(known[id]!).port) } : undefined,
    call: vi.fn().mockResolvedValue({ ok: true, statusCode: 200 }),
    stream: vi.fn(),
  };
}

describe("RuntimeServiceTransport", () => {
  const generated = new HttpServiceTransport({
    services: { rest: { url: "http://127.0.0.1:41001" } },
    offset: 0,
  });

  it("ignores hand-written ports for the ids the runtime owns", () => {
    const transport = new RuntimeServiceTransport(
      generated,
      configured({ rest: "http://127.0.0.1:5050", marketplace: "http://127.0.0.1:5070" }),
    );

    expect(transport.listenAddress("rest")).toEqual({ port: 41001 });
    expect(transport.connectionInfo("rest")?.baseUrl).toBe("http://127.0.0.1:41001");
  });

  it("falls through to the configured transport for ids it does not own", () => {
    const transport = new RuntimeServiceTransport(
      generated,
      configured({ marketplace: "http://127.0.0.1:5070" }),
    );

    expect(transport.connectionInfo("marketplace")?.baseUrl).toBe("http://127.0.0.1:5070");
    expect(transport.connectionInfo("unknown")).toBeUndefined();
  });

  it("works without a configured transport", () => {
    const transport = new RuntimeServiceTransport(generated);
    expect(transport.connectionInfo("rest")).toBeDefined();
    expect(transport.connectionInfo("workflow")).toBeUndefined();
  });
});
