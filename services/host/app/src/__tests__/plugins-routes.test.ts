/**
 * `/api/v1/plugins` host routes: the same marketplace operations as `kb
 * marketplace plugins list|enable|disable`, over HTTP. Uses a real registry
 * against a temp `KB_HOME` and a stubbed {@link MarketplaceClient} (the real
 * one talks to a live marketplace service; that HTTP contract is exercised by
 * `services/marketplace/api`'s own tests).
 */

import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createProjectRegistry } from "@kb-labs/core-project-registry";
import type { IProjectRegistry } from "@kb-labs/core-project-registry";
import { createPluginsRoutes } from "../plugins-routes.js";
import { MarketplaceClientError, type MarketplaceClient } from "../marketplace-client.js";

interface ErrorBody {
  ok: false;
  error: { code: string; message: string; hint: string };
}

interface DataBody<T> {
  ok: true;
  data: T;
}

function stubMarketplace(overrides: Partial<MarketplaceClient> = {}): MarketplaceClient {
  return {
    listPackages: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    installPackages: vi.fn().mockResolvedValue({ installed: [] }),
    uninstallPackages: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MarketplaceClient;
}

describe("createPluginsRoutes", () => {
  let kbHome: string;
  let registry: IProjectRegistry;
  let projectDir: string;
  let projectId: string;
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    kbHome = await mkdtemp(join(tmpdir(), "kb-host-plugins-"));
    registry = createProjectRegistry({ root: kbHome });
    // realpath: the registry canonicalizes the added path (macOS /tmp -> /private/tmp),
    // so project.path (used to build assertions below) must match this, not the raw mkdtemp path.
    projectDir = await realpath(await mkdtemp(join(tmpdir(), "kb-plugins-proj-")));
    await mkdir(join(projectDir, ".kb"));
    const { project } = await registry.add(projectDir);
    projectId = project.id;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await rm(kbHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  async function setup(marketplace: MarketplaceClient) {
    app = Fastify();
    await app.register(createPluginsRoutes({ registry, marketplace }));
    await app.ready();
    return app;
  }

  it("GET lists plugins scoped to the project's path", async () => {
    const marketplace = stubMarketplace({
      listPackages: vi.fn().mockResolvedValue({
        entries: [{ id: "@kb-labs/commit", version: "1.0.0", source: "workspace", primaryKind: "plugin", provides: ["plugin"], enabled: true, scope: "project" }],
        total: 1,
      }),
    });
    const instance = await setup(marketplace);

    const res = await instance.inject({ method: "GET", url: `/api/v1/plugins?projectId=${projectId}` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as DataBody<Array<{ id: string; enabled: boolean }>>;
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ id: "@kb-labs/commit", enabled: true });
    expect(marketplace.listPackages).toHaveBeenCalledWith({
      kind: "plugin",
      scope: "project",
      projectRoot: projectDir,
    });
  });

  it("GET without projectId returns KB_RUNTIME_INPUT_INVALID", async () => {
    const instance = await setup(stubMarketplace());

    const res = await instance.inject({ method: "GET", url: "/api/v1/plugins" });

    expect(res.statusCode).toBe(400);
    expect((res.json() as ErrorBody).error.code).toBe("KB_RUNTIME_INPUT_INVALID");
  });

  it("GET for an unregistered project returns KB_PROJECT_UNKNOWN", async () => {
    const instance = await setup(stubMarketplace());

    const res = await instance.inject({ method: "GET", url: "/api/v1/plugins?projectId=prj_missing" });

    expect(res.statusCode).toBe(404);
    expect((res.json() as ErrorBody).error.code).toBe("KB_PROJECT_UNKNOWN");
  });

  it("POST /plugins/enable calls the marketplace client with scope=project", async () => {
    const marketplace = stubMarketplace();
    const instance = await setup(marketplace);

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/plugins/enable",
      payload: { projectId, packageId: "@kb-labs/commit" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as DataBody<{ id: string; enabled: boolean }>;
    expect(body.data).toEqual({ id: "@kb-labs/commit", enabled: true, scope: "project" });
    expect(marketplace.setEnabled).toHaveBeenCalledWith(
      { packageId: "@kb-labs/commit", scope: "project", projectRoot: projectDir },
      true,
    );
  });

  it("POST /plugins/disable maps a 404 from the marketplace to KB_PLUGIN_NOT_FOUND", async () => {
    const marketplace = stubMarketplace({
      setEnabled: vi.fn().mockRejectedValue(new MarketplaceClientError(404, "not found")),
    });
    const instance = await setup(marketplace);

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/plugins/disable",
      payload: { projectId, packageId: "@kb-labs/unknown" },
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as ErrorBody).error).toMatchObject({
      code: "KB_PLUGIN_NOT_FOUND",
      details: { plugin: "@kb-labs/unknown" },
    });
  });

  it("POST /plugins/enable without packageId returns KB_RUNTIME_INPUT_INVALID", async () => {
    const instance = await setup(stubMarketplace());

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/plugins/enable",
      payload: { projectId },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as ErrorBody).error.code).toBe("KB_RUNTIME_INPUT_INVALID");
  });

  it("POST /plugins/install installs a package into the selected project scope", async () => {
    const marketplace = stubMarketplace({ installPackages: vi.fn().mockResolvedValue({ installed: [{ id: "@kb/demo", version: "1.0.0" }] }) });
    const instance = await setup(marketplace);

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/plugins/install",
      payload: { projectId, spec: "@kb/demo@1.0.0" },
    });

    expect(res.statusCode).toBe(201);
    expect(marketplace.installPackages).toHaveBeenCalledWith({
      specs: ["@kb/demo@1.0.0"], scope: "project", projectRoot: projectDir,
    });
  });

  it("POST /plugins/uninstall removes the package pin from the selected project", async () => {
    const marketplace = stubMarketplace();
    const instance = await setup(marketplace);

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/plugins/uninstall",
      payload: { projectId, packageId: "@kb/demo" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, data: { id: "@kb/demo", removed: true } });
    expect(marketplace.uninstallPackages).toHaveBeenCalledWith({
      packageIds: ["@kb/demo"], scope: "project", projectRoot: projectDir,
    });
  });
});
