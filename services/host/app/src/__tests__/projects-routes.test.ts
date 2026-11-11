/**
 * `/api/v1/projects` host routes: the same operations as `kb project *`, over
 * HTTP. Uses a real registry against a temp `KB_HOME` and a stubbed runtime
 * manager (only `status()` is exercised by this module).
 */

import { mkdtemp, mkdir, readdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createProjectRegistry } from "@kb-labs/core-project-registry";
import type { IProjectRegistry } from "@kb-labs/core-project-registry";
import { createProjectsRoutes } from "../projects-routes.js";
import type { ManagerSnapshot, ProjectRuntimeManager } from "../project-runtime/manager.js";

function stubManager(snapshot: ManagerSnapshot): ProjectRuntimeManager {
  return { status: () => snapshot } as unknown as ProjectRuntimeManager;
}

const EMPTY_SNAPSHOT: ManagerSnapshot = { limit: 4, active: 0, runtimes: [] };

interface ErrorBody {
  ok: false;
  error: { code: string; message: string; hint: string };
}

interface DataBody<T> {
  ok: true;
  data: T;
}

describe("createProjectsRoutes", () => {
  let kbHome: string;
  let registry: IProjectRegistry;
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    kbHome = await mkdtemp(join(tmpdir(), "kb-host-projects-"));
    registry = createProjectRegistry({ root: kbHome });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await rm(kbHome, { recursive: true, force: true });
  });

  async function setup(manager: ProjectRuntimeManager = stubManager(EMPTY_SNAPSHOT)) {
    app = Fastify();
    await app.register(createProjectsRoutes({ registry, manager }));
    await app.ready();
    return app;
  }

  it("lists registered projects with stopped runtime state when none is active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-proj-"));
    await mkdir(join(dir, ".kb"));
    const { project } = await registry.add(dir);
    const instance = await setup();

    const res = await instance.inject({ method: "GET", url: "/api/v1/projects" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as DataBody<Array<{ id: string; runtime: { state: string } }>>;
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ id: project.id, runtime: { state: "stopped" } });
  });

  it("reports runtime state from the manager snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-proj-"));
    await mkdir(join(dir, ".kb"));
    const { project } = await registry.add(dir);
    const instance = await setup(
      stubManager({
        limit: 4,
        active: 1,
        runtimes: [
          {
            projectId: project.id,
            state: "ready",
            lastUsedAt: "2026-01-01T00:00:00.000Z",
            inflight: 0,
            restarts: 2,
            keptRunningSchedules: 0,
          },
        ],
      }),
    );

    const res = await instance.inject({ method: "GET", url: `/api/v1/projects/${project.id}` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as DataBody<{ runtime: { state: string; restarts: number } }>;
    expect(body.data.runtime).toEqual({
      state: "ready",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      restarts: 2,
      keptRunningSchedules: 0,
    });
  });

  it("GET /api/v1/projects/:id returns KB_PROJECT_UNKNOWN for an unregistered id", async () => {
    const instance = await setup();

    const res = await instance.inject({ method: "GET", url: "/api/v1/projects/prj_missing" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false, error: {
      code: "KB_PROJECT_UNKNOWN",
      message: expect.any(String),
      hint: expect.any(String),
      correlationId: expect.any(String),
    } });
  });

  it("POST registers a folder that already has .kb/", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "kb-proj-")));
    await mkdir(join(dir, ".kb"));
    const instance = await setup();

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { path: dir },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as DataBody<{ path: string; runtime: { state: string } }>;
    expect(body.data.path).toBe(dir);
    expect(body.data.runtime.state).toBe("stopped");
    expect((await registry.list()).projects).toHaveLength(1);
  });

  it("POST registers a folder without .kb/ and leaves it unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-proj-"));
    const instance = await setup();

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { path: dir },
    });

    expect(res.statusCode).toBe(201);
    expect(await readdir(dir)).toEqual([]);
    expect((await registry.list()).projects).toHaveLength(1);
  });

  it("POST rejects a missing path with KB_RUNTIME_INPUT_INVALID", async () => {
    const instance = await setup();

    const res = await instance.inject({ method: "POST", url: "/api/v1/projects", payload: {} });

    expect(res.statusCode).toBe(400);
    expect((res.json() as ErrorBody).error.code).toBe("KB_RUNTIME_INPUT_INVALID");
  });

  // case: S-124.14
  it("POST returns the existing project for a duplicate canonical path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-proj-"));
    await mkdir(join(dir, ".kb"));
    await registry.add(dir);
    const instance = await setup();

    const res = await instance.inject({ method: "POST", url: "/api/v1/projects", payload: { path: dir } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, data: { path: await realpath(dir), alreadyExisted: true } });

    const renamed = await instance.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { path: dir, name: "another-name" },
    });
    expect(renamed.statusCode).toBe(409);
    expect((renamed.json() as ErrorBody).error.code).toBe("KB_PROJECT_ALREADY_REGISTERED");
  });

  it("DELETE unregisters a project without touching its folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-proj-"));
    await mkdir(join(dir, ".kb"));
    const { project } = await registry.add(dir);
    const instance = await setup();

    const res = await instance.inject({ method: "DELETE", url: `/api/v1/projects/${project.id}` });

    expect(res.statusCode).toBe(200);
    expect((res.json() as DataBody<{ id: string }>).data.id).toBe(project.id);
    expect((await registry.list()).projects).toHaveLength(0);
  });

  it("DELETE of an unknown id returns KB_PROJECT_UNKNOWN", async () => {
    const instance = await setup();

    const res = await instance.inject({ method: "DELETE", url: "/api/v1/projects/prj_missing" });

    expect(res.statusCode).toBe(404);
    expect((res.json() as ErrorBody).error.code).toBe("KB_PROJECT_UNKNOWN");
  });
});
