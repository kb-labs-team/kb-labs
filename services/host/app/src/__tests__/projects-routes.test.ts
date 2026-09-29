/**
 * `/api/v1/projects` host routes: the same operations as `kb project *`, over
 * HTTP. Uses a real registry against a temp `KB_HOME` and a stubbed runtime
 * manager (only `status()` is exercised by this module).
 */

import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { IProjectRegistry } from "@kb-labs/core-contracts";
import { createProjectRegistry } from "@kb-labs/core-project-registry";
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

  async function setup(manager: ProjectRuntimeManager = stubManager(EMPTY_SNAPSHOT), pickFolder?: () => Promise<string | null>) {
    app = Fastify();
    await app.register(createProjectsRoutes({ registry, manager, pickFolder }));
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

  it("returns the absolute folder selected by the Host native picker", async () => {
    const selectedPath = await realpath(kbHome);
    const picker = vi.fn().mockResolvedValue(selectedPath);
    const instance = await setup(stubManager(EMPTY_SNAPSHOT), picker);

    const res = await instance.inject({ method: "POST", url: "/api/v1/projects/pick-folder" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, data: { path: selectedPath } });
    expect(picker).toHaveBeenCalledOnce();
  });

  it("returns a successful null result when the native picker is cancelled", async () => {
    const instance = await setup(stubManager(EMPTY_SNAPSHOT), async () => null);
    const res = await instance.inject({ method: "POST", url: "/api/v1/projects/pick-folder" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, data: { path: null } });
  });

  it("reports native picker availability failures with a dedicated host error", async () => {
    const instance = await setup(stubManager(EMPTY_SNAPSHOT), async () => {
      throw new Error("No desktop session");
    });
    const res = await instance.inject({ method: "POST", url: "/api/v1/projects/pick-folder" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      ok: false,
      error: {
        code: "KB_HOST_FOLDER_PICKER_UNAVAILABLE",
        cause: "No desktop session",
      },
    });
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
          },
        ],
      }),
    );

    const res = await instance.inject({ method: "GET", url: `/api/v1/projects/${project.id}` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as DataBody<{ runtime: { state: string; restarts: number } }>;
    expect(body.data.runtime).toEqual({ state: "ready", lastUsedAt: "2026-01-01T00:00:00.000Z", restarts: 2 });
  });

  it("GET /api/v1/projects/:id returns KB_PROJECT_UNKNOWN for an unregistered id", async () => {
    const instance = await setup();

    const res = await instance.inject({ method: "GET", url: "/api/v1/projects/prj_missing" });

    expect(res.statusCode).toBe(404);
    expect((res.json() as ErrorBody).error.code).toBe("KB_PROJECT_UNKNOWN");
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
    expect(await registry.list()).toHaveLength(1);
  });

  it("POST initializes the exact selected folder with metadata", async () => {
    const selectedFolder = join(kbHome, "workspaces", "new-workspace");
    await mkdir(selectedFolder, { recursive: true });
    const instance = await setup();

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        path: selectedFolder,
        init: true,
        title: "New workspace",
        description: "Created from Studio",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as DataBody<{ id: string; path: string; title: string; description: string }>;
    expect(body.data).toMatchObject({
      path: await realpath(selectedFolder),
      title: "New workspace",
      description: "Created from Studio",
    });
    await expect(mkdir(join(selectedFolder, ".kb"))).rejects.toMatchObject({ code: "EEXIST" });
    expect((await registry.get(body.data.id)).project.path).toBe(body.data.path);
  });

  it("PATCH updates project metadata and path without changing the project id", async () => {
    const originalPath = join(kbHome, "before");
    const updatedPath = join(kbHome, "after");
    await mkdir(originalPath);
    await mkdir(updatedPath);
    await mkdir(join(originalPath, ".kb"));
    await mkdir(join(updatedPath, ".kb"));
    const { project } = await registry.add(originalPath, { title: "Original title" });
    const instance = await setup();

    const res = await instance.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}`,
      payload: { path: updatedPath, title: "Current title", description: "Relocated" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as DataBody<{ id: string; path: string; title: string; description: string }>;
    expect(body.data).toMatchObject({
      id: project.id,
      path: await realpath(updatedPath),
      title: "Current title",
      description: "Relocated",
    });
  });

  it("PATCH rejects an empty replacement path", async () => {
    const projectPath = join(kbHome, "project");
    await mkdir(join(projectPath, ".kb"), { recursive: true });
    const { project } = await registry.add(projectPath);
    const instance = await setup();

    const res = await instance.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}`,
      payload: { path: " " },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as ErrorBody).error.code).toBe("KB_RUNTIME_INPUT_INVALID");
  });

  it("POST without init reports KB_PROJECT_INIT_REQUIRED and registers nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-proj-"));
    const instance = await setup();

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { path: dir },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as ErrorBody).error.code).toBe("KB_PROJECT_INIT_REQUIRED");
    expect(await registry.list()).toHaveLength(0);
  });

  it("POST with init creates .kb/ and registers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-proj-"));
    const instance = await setup();

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { path: dir, init: true },
    });

    expect(res.statusCode).toBe(201);
    expect(await registry.list()).toHaveLength(1);
  });

  it("POST rejects a missing path with KB_RUNTIME_INPUT_INVALID", async () => {
    const instance = await setup();

    const res = await instance.inject({ method: "POST", url: "/api/v1/projects", payload: {} });

    expect(res.statusCode).toBe(400);
    expect((res.json() as ErrorBody).error.code).toBe("KB_RUNTIME_INPUT_INVALID");
  });

  it("POST rejects a duplicate registration with KB_PROJECT_ALREADY_REGISTERED", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-proj-"));
    await mkdir(join(dir, ".kb"));
    await registry.add(dir);
    const instance = await setup();

    const res = await instance.inject({ method: "POST", url: "/api/v1/projects", payload: { path: dir } });

    expect(res.statusCode).toBe(409);
    expect((res.json() as ErrorBody).error.code).toBe("KB_PROJECT_ALREADY_REGISTERED");
  });

  it("DELETE unregisters a project without touching its folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kb-proj-"));
    await mkdir(join(dir, ".kb"));
    const { project } = await registry.add(dir);
    const instance = await setup();

    const res = await instance.inject({ method: "DELETE", url: `/api/v1/projects/${project.id}` });

    expect(res.statusCode).toBe(200);
    expect((res.json() as DataBody<{ id: string }>).data.id).toBe(project.id);
    expect(await registry.list()).toHaveLength(0);
  });

  it("DELETE of an unknown id returns KB_PROJECT_UNKNOWN", async () => {
    const instance = await setup();

    const res = await instance.inject({ method: "DELETE", url: "/api/v1/projects/prj_missing" });

    expect(res.statusCode).toBe(404);
    expect((res.json() as ErrorBody).error.code).toBe("KB_PROJECT_UNKNOWN");
  });
});
