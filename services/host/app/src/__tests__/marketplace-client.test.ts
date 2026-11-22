import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@kb-labs/gateway-contracts";
import { MarketplaceClient } from "../marketplace-client.js";

const caller: AuthContext = {
  type: "user", userId: "user-1", namespaceId: "tenant-1", tier: "pro",
  permissions: ["plugins:read", "plugins:write"],
};

describe("MarketplaceClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls the versioned Marketplace route and forwards the caller identity", async () => {
    let capturedInput: string | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      capturedInput = input;
      capturedInit = init;
      return new Response(JSON.stringify({ entries: [], total: 0 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new MarketplaceClient("http://127.0.0.1:5070", "internal-test-secret");

    await client.listPackages({ scope: "project", projectRoot: "/projects/demo" }, caller);

    const url = new URL(String(capturedInput));
    expect(url.pathname).toBe("/api/v1/marketplace/packages");
    expect(url.searchParams.get("scope")).toBe("project");
    expect(url.searchParams.get("projectRoot")).toBe("/projects/demo");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("x-internal-secret")).toBe("internal-test-secret");
    expect(headers.get("x-kb-auth-user-id")).toBe("user-1");
    expect(headers.get("x-kb-auth-namespace-id")).toBe("tenant-1");
    expect(JSON.parse(headers.get("x-kb-auth-permissions") ?? "[]")).toEqual(caller.permissions);
  });
});
