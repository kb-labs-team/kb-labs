import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { IEntityRegistry } from "@kb-labs/plugin-contracts";
import { platform } from "@kb-labs/core-runtime";
import type { RestApiConfig } from "@kb-labs/rest-api-core";
import { registerPluginRouteNotFoundHandler } from "../plugin-route-not-found.js";

const config: RestApiConfig = {
  port: 3000,
  basePath: "/api/v1",
  apiVersion: "test",
  cors: { origins: [], allowCredentials: true, profile: "dev" },
  plugins: [],
  mockMode: false,
  timeouts: { requestTimeout: 30_000, bodyLimit: 10_485_760 },
};

describe("plugin route not-found response", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  async function server(registry: IEntityRegistry) {
    const app = Fastify();
    servers.push(app);
    registerPluginRouteNotFoundHandler(
      app as unknown as Parameters<typeof registerPluginRouteNotFoundHandler>[0],
      config,
      registry,
    );
    await app.ready();
    return app;
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((app) => app.close()));
  });

  // case: S-192.3
  it("returns the exact install hint when the store knows the absent plugin package", async () => {
    const registry = {
      snapshot: () => ({ manifests: [] }),
      findStoredPluginPackageForRestPrefix: async () => "@third-party/custom-rest-plugin",
    } as unknown as IEntityRegistry;
    const app = await server(registry);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/plugins/custom/status",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "KB_PLUGIN_NOT_INSTALLED",
        message: "Plugin is not installed in this project.",
        hint: "Run `kb marketplace install @third-party/custom-rest-plugin` in this project.",
        correlationId: expect.any(String),
      },
    });
  });

  it("uses plugin discovery guidance when no stored manifest declares the prefix", async () => {
    const registry = {
      snapshot: () => ({ manifests: [] }),
      findStoredPluginPackageForRestPrefix: async () => undefined,
    } as unknown as IEntityRegistry;
    const app = await server(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/plugins/mistyped/status" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({
      code: "KB_PLUGIN_NOT_INSTALLED",
      hint: "Run `kb marketplace plugins list` to discover available plugins.",
    });
    expect(JSON.stringify(response.json())).not.toContain("@kb-labs/mistyped");
  });

  // case: S-203.2
  it("returns the resource-not-found envelope for an unmatched non-plugin REST route", async () => {
    const registry = {
      snapshot: () => ({ manifests: [] }),
      findStoredPluginPackageForRestPrefix: async () => undefined,
    } as unknown as IEntityRegistry;
    const app = await server(registry);

    const response = await app.inject({ method: "POST", url: "/api/v1/not-a-route?source=test" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "KB_RUNTIME_RESOURCE_NOT_FOUND",
        message: "REST route POST /api/v1/not-a-route was not found.",
        details: { route: "POST /api/v1/not-a-route" },
        correlationId: expect.any(String),
      },
    });
  });

  it("logs store lookup failures with the request correlation id and keeps the typed 404", async () => {
    const warn = vi.spyOn(platform.logger, "warn");
    const registry = {
      snapshot: () => ({ manifests: [] }),
      findStoredPluginPackageForRestPrefix: async () => { throw new Error("store read failed"); },
    } as unknown as IEntityRegistry;
    const app = await server(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/plugins/unknown/status" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({
      code: "KB_PLUGIN_NOT_INSTALLED",
      hint: "Run `kb marketplace plugins list` to discover available plugins.",
      correlationId: "req-1",
    });
    expect(warn).toHaveBeenCalledWith(
      "Failed to resolve stored plugin package for absent REST prefix",
      expect.objectContaining({ correlationId: "req-1", requestedPrefix: "/api/v1/plugins/unknown" }),
    );
  });

  // case: S-141.6
  it("returns a typed route-specific 404 under an installed plugin", async () => {
    const registry = {
      snapshot: () => ({ manifests: [{ scope: "platform", pluginId: "@kb-labs/commit", pluginRoot: "/mock/commit", manifest: {
        id: "@kb-labs/commit",
        rest: { basePath: "/v1/plugins/commit", routes: [{ method: "GET", path: "/status" }] },
      } }] }),
    } as unknown as IEntityRegistry;
    const app = await server(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/plugins/commit/unknown" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "KB_RUNTIME_RESOURCE_NOT_FOUND",
        message: "REST route GET /api/v1/plugins/commit/unknown was not found for plugin @kb-labs/commit.",
        hint: "Run `kb marketplace plugins doctor --scope project` to inspect project plugin routes, then use a declared route.",
        correlationId: expect.any(String),
      },
    });
  });
});
