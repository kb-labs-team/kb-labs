/**
 * `/api/v1/adapters` host routes: the same operations as `kb config get|set`
 * on `adapterOptions.<name>`, over HTTP, against a real project config on a
 * temp `KB_HOME` and a temp platform root.
 */

import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { IProjectRegistry } from "@kb-labs/core-contracts";
import { createProjectRegistry } from "@kb-labs/core-project-registry";
import { createAdaptersRoutes } from "../adapters-routes.js";

interface ErrorBody {
  ok: false;
  error: { code: string; message: string; hint: string };
}

interface DataBody<T> {
  ok: true;
  data: T;
}

describe("createAdaptersRoutes", () => {
  let kbHome: string;
  let platformRoot: string;
  let registry: IProjectRegistry;
  let projectDir: string;
  let projectId: string;
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    kbHome = await mkdtemp(join(tmpdir(), "kb-host-adapters-"));
    platformRoot = await mkdtemp(join(tmpdir(), "kb-adapters-platform-"));
    registry = createProjectRegistry({ root: kbHome });
    // realpath: the registry canonicalizes the added path (macOS /tmp -> /private/tmp).
    projectDir = await realpath(await mkdtemp(join(tmpdir(), "kb-adapters-proj-")));
    await mkdir(join(projectDir, ".kb"));
    await writeFile(
      join(projectDir, ".kb", "kb.config.json"),
      JSON.stringify({ platform: { adapters: { cache: "@kb-labs/adapters-fs-cache" } } }),
    );
    const { project } = await registry.add(projectDir);
    projectId = project.id;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await rm(kbHome, { recursive: true, force: true });
    await rm(platformRoot, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  async function setup() {
    app = Fastify();
    await app.register(createAdaptersRoutes({ registry, platformRoot }));
    await app.ready();
    return app;
  }

  it("GET lists the project's configured adapter slots", async () => {
    const instance = await setup();

    const res = await instance.inject({ method: "GET", url: `/api/v1/adapters?projectId=${projectId}` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as DataBody<Array<{ name: string; spec?: string; options: Record<string, unknown> }>>;
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ name: "cache", spec: "@kb-labs/adapters-fs-cache", options: {} });
  });

  it("GET without projectId returns KB_RUNTIME_INPUT_INVALID", async () => {
    const instance = await setup();

    const res = await instance.inject({ method: "GET", url: "/api/v1/adapters" });

    expect(res.statusCode).toBe(400);
    expect((res.json() as ErrorBody).error.code).toBe("KB_RUNTIME_INPUT_INVALID");
  });

  it("GET for an unregistered project returns KB_PROJECT_UNKNOWN", async () => {
    const instance = await setup();

    const res = await instance.inject({ method: "GET", url: "/api/v1/adapters?projectId=prj_missing" });

    expect(res.statusCode).toBe(404);
    expect((res.json() as ErrorBody).error.code).toBe("KB_PROJECT_UNKNOWN");
  });

  it("POST configure writes adapterOptions.<name> into the project's user config", async () => {
    const instance = await setup();

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/adapters/cache/configure",
      payload: { projectId, options: { ttlSeconds: 3600 } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as DataBody<{ name: string; changed: boolean; options: Record<string, unknown> }>;
    expect(body.data).toMatchObject({ name: "cache", changed: true, options: { ttlSeconds: 3600 } });

    // The route writes to the FIRST existing candidate (`resolveUserConfigFile`):
    // `.kb/kb.config.json` here, since `beforeEach` pre-created it and no
    // `.kb/kb.config.jsonc` exists — a fresh project would get `.jsonc` instead.
    const written = JSON.parse(await readFile(join(projectDir, ".kb", "kb.config.json"), "utf8")) as {
      platform?: { adapterOptions?: { cache?: { ttlSeconds?: number } } };
    };
    expect(written.platform?.adapterOptions?.cache?.ttlSeconds).toBe(3600);

    const listRes = await instance.inject({ method: "GET", url: `/api/v1/adapters?projectId=${projectId}` });
    const listBody = listRes.json() as DataBody<Array<{ name: string; options: Record<string, unknown> }>>;
    expect(listBody.data[0]?.options).toEqual({ ttlSeconds: 3600 });
  });

  it("POST configure without an options object returns KB_RUNTIME_INPUT_INVALID", async () => {
    const instance = await setup();

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/adapters/cache/configure",
      payload: { projectId },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as ErrorBody).error.code).toBe("KB_RUNTIME_INPUT_INVALID");
  });
});
