import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketplaceClient } from "../marketplace-client.js";

describe("MarketplaceClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // case: S-251.1
  it("uses the mounted Marketplace API prefix for project plugin operations", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new MarketplaceClient("http://127.0.0.1:5070");

    await client.listPackages({ kind: "plugin", scope: "project", projectRoot: "/project-a" });
    await client.setEnabled({ packageId: "@kb-labs/commit", scope: "project", projectRoot: "/project-a" }, true);
    await client.installPackages({ specs: ["@kb-labs/commit"], scope: "project", projectRoot: "/project-a" });
    await client.uninstallPackages({ packageIds: ["@kb-labs/commit"], scope: "project", projectRoot: "/project-a" });

    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toEqual([
      "/api/v1/marketplace/packages",
      "/api/v1/marketplace/packages/enable",
      "/api/v1/marketplace/packages/install",
      "/api/v1/marketplace/packages/uninstall",
    ]);
  });

  it("uses a service-only forwarded identity for Registry project installs", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({ installed: [], warnings: [], scope: "project" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new MarketplaceClient("http://127.0.0.1:5070", "gateway-internal-secret");

    await client.installRegistryPackage({ spec: "@kb-labs/commit@1.2.3", scope: "project", projectRoot: "/registered/project" });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe("/api/v1/marketplace/packages/registry/install");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": "gateway-internal-secret",
      },
      body: JSON.stringify({ spec: "@kb-labs/commit@1.2.3", scope: "project", projectRoot: "/registered/project" }),
    });
    expect(init?.headers).not.toHaveProperty("x-kb-auth-type");
    expect(init?.headers).not.toHaveProperty("x-kb-auth-user-id");
  });
});
