import { afterEach, describe, expect, it } from "vitest";
import type { ActiveWorkRegistry } from "@kb-labs/shared-daemon";
import type { ProjectRuntimeManager } from "../project-runtime/manager.js";
import { startHostActiveWorkControl } from "../active-work-control.js";
import { MarketplaceClientError, type MarketplaceClient } from "../marketplace-client.js";

describe("host Marketplace control", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
  });

  const providers = { list: async () => [] } as unknown as ActiveWorkRegistry;
  const runtimes = { listActiveWork: async () => [] } as unknown as ProjectRuntimeManager;
  const input = {
    installationId: "install-1",
    scope: "platform" as const,
    expected: [{
      spec: "@kb-labs/commit",
      id: "@kb-labs/commit",
      version: "1.2.3",
      source: "registry" as const,
      primaryKind: "plugin" as const,
      signatureStatus: "verified" as const,
      integrity: "sha512-fixture",
    }],
  };

  it("requires machine control auth and exact installation identity", async () => {
    const marketplace = {
      reconcileMarketplace: async (request: { expected: Array<Record<string, unknown>> }) => ({ ok: true, matched: [{ ...request.expected[0], enabled: true }] }),
    } as unknown as MarketplaceClient;
    const control = await startHostActiveWorkControl("host-control-secret-which-is-long-enough", providers, runtimes, "install-1", marketplace);
    cleanups.push(() => control.close());

    expect((await fetch(`${control.address}/v1/marketplace/reconcile`, { method: "POST", body: JSON.stringify(input) })).status).toBe(403);
    const response = await fetch(`${control.address}/v1/marketplace/reconcile`, {
      method: "POST", headers: { Authorization: "Bearer host-control-secret-which-is-long-enough", "content-type": "application/json" }, body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, installationId: "install-1", matched: [{ ...input.expected[0], enabled: true }] });
    const wrongInstallation = await fetch(`${control.address}/v1/marketplace/reconcile`, {
      method: "POST", headers: { Authorization: "Bearer host-control-secret-which-is-long-enough", "content-type": "application/json" }, body: JSON.stringify({ ...input, installationId: "install-2" }),
    });
    expect(wrongInstallation.status).toBe(409);
  });

  it("returns catalogued drift without exposing the Marketplace response body", async () => {
    const marketplace = {
      reconcileMarketplace: async () => {throw new MarketplaceClientError(409, "untrusted body bearer-secret");},
    } as unknown as MarketplaceClient;
    const control = await startHostActiveWorkControl("host-control-secret-which-is-long-enough", providers, runtimes, "install-1", marketplace);
    cleanups.push(() => control.close());
    const response = await fetch(`${control.address}/v1/marketplace/reconcile`, {
      method: "POST", headers: { Authorization: "Bearer host-control-secret-which-is-long-enough", "content-type": "application/json" }, body: JSON.stringify(input),
    });
    const body = await response.text();
    expect(response.status).toBe(409);
    expect(body).toContain("KB_MARKETPLACE_STATE_DRIFT");
    expect(body).not.toContain("bearer-secret");
  });
});
