/**
 * The host with project routing: real gateway, real `launchPlatform`, real
 * project registry (temp KB_HOME) and real child processes, with the fake
 * runtime script standing in for `kb-project-runtime`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IProjectRegistry } from "@kb-labs/core-contracts";
import { createProjectRegistry } from "@kb-labs/core-project-registry";
import { startTestHost, type RunningHost } from "./harness.js";
import {
  FAKE_RUNTIME_ENTRY,
  isAlive,
  makeProject,
  waitFor,
  type FakeRuntimeReply,
  type TestProject,
} from "./testkit.js";
import type { HostOptions } from "../host.js";

interface ErrorBody {
  error: { code: string; message: string; hint: string; details?: Record<string, string> };
}

interface HealthBody {
  projectRuntimes: {
    limit: number;
    active: number;
    runtimes: Array<{ projectId: string; state: string; inflight: number }>;
  };
}

interface ReadyBody {
  ready: boolean;
  components: Record<string, { ready: boolean; status?: string }>;
}

describe("kb-host project routing", () => {
  let kbHome: string;
  let registry: IProjectRegistry;
  let running: RunningHost | undefined;
  const projects: TestProject[] = [];

  beforeEach(async () => {
    kbHome = await mkdtemp(join(tmpdir(), "kb-home-test-"));
    registry = createProjectRegistry({ root: kbHome });
  });

  afterEach(async () => {
    await running?.stop().catch(() => undefined);
    running = undefined;
    await Promise.all(projects.splice(0).map((p) => p.cleanup()));
    await rm(kbHome, { recursive: true, force: true });
  });

  async function registered(
    behavior: Parameters<typeof makeProject>[0] = {},
  ): Promise<TestProject> {
    const project = await makeProject(behavior);
    projects.push(project);
    await registry.add(project.root);
    return project;
  }

  async function host(
    hostSection: Record<string, unknown> = {},
    options: HostOptions["projectRuntime"] = {},
  ): Promise<RunningHost> {
    running = await startTestHost(
      { host: hostSection },
      {
        projectRegistry: registry,
        projectRuntime: { entry: FAKE_RUNTIME_ENTRY, stopTimeoutMs: 1500, ...options },
      },
    );
    return running;
  }

  async function reply(
    subject: RunningHost,
    projectId: string,
    path: string,
    init?: RequestInit,
  ): Promise<FakeRuntimeReply> {
    const response = await subject.fetchGateway(
      `/api/v1/projects/${projectId}${path}`,
      init,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as FakeRuntimeReply;
  }

  it("routes each project id to its own runtime, so the projects are isolated", async () => {
    const a = await registered();
    const b = await registered();
    const subject = await host();

    const fromA = await reply(subject, a.id, "/rest/whoami");
    const fromB = await reply(subject, b.id, "/rest/whoami");
    const fromAAgain = await reply(subject, a.id, "/rest/whoami");

    expect(fromA.projectRoot).toBe(a.root);
    expect(fromA.projectId).toBe(a.id);
    expect(fromB.projectRoot).toBe(b.root);
    expect(fromB.projectId).toBe(b.id);
    expect(fromA.pid).not.toBe(fromB.pid);
    expect(fromAAgain.pid).toBe(fromA.pid);
    // The service path after the project id reaches the runtime unchanged.
    expect(fromA.path).toBe("/rest/whoami");
  });

  it("forwards method, query and body, and sets the runtime headers itself", async () => {
    const a = await registered();
    const subject = await host();

    const echoed = await reply(subject, a.id, "/rest/items?limit=5&sort=asc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer caller-token",
        // A client must not be able to speak to the runtime as the host.
        "x-kb-runtime-token": "forged",
        "x-kb-project-id": "prj_forged",
      },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(echoed.method).toBe("POST");
    expect(echoed.search).toBe("?limit=5&sort=asc");
    expect(JSON.parse(echoed.body)).toEqual({ hello: "world" });
    expect(echoed.received.authorization).toBe("Bearer caller-token");
    expect(echoed.received.projectHeader).toBe(a.id);
    expect(echoed.received.tokenHeader).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps runtime addresses and secrets out of the public health payload", async () => {
    const a = await registered();
    const subject = await host();
    await reply(subject, a.id, "/rest/whoami");
    const runtime = (await (await subject.fetchGateway("/health")).json()) as HealthBody;
    expect(runtime.projectRuntimes.runtimes).toHaveLength(1);
    // Nothing in the public health payload reveals the runtime's address.
    expect(JSON.stringify(runtime)).not.toMatch(/127\.0\.0\.1:\d+/);
    expect(JSON.stringify(runtime)).not.toContain("port");
  });

  it("answers KB_PROJECT_UNKNOWN for an id that is not in the registry, without starting anything", async () => {
    const subject = await host();

    const response = await subject.fetchGateway(
      "/api/v1/projects/prj_0000000000000000/rest/whoami",
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe("KB_PROJECT_UNKNOWN");
    expect(body.error.hint.length).toBeGreaterThan(0);
    const health = (await (await subject.fetchGateway("/health")).json()) as HealthBody;
    expect(health.projectRuntimes.runtimes).toEqual([]);
  });

  it("addresses projects by id only, not by registered name or path", async () => {
    const a = await registered();
    const subject = await host();
    const view = await registry.get(a.id);

    for (const ref of [view.project.name, encodeURIComponent(a.root)]) {
      const response = await subject.fetchGateway(
        `/api/v1/projects/${ref}/rest/whoami`,
      );
      expect(response.status).toBe(404);
      expect(((await response.json()) as ErrorBody).error.code).toBe(
        "KB_PROJECT_UNKNOWN",
      );
    }
  });

  it("answers KB_PROJECT_RUNTIME_START_FAILED when the runtime does not start", async () => {
    const a = await registered({ exitBeforeReady: 4 });
    const subject = await host();

    const response = await subject.fetchGateway(
      `/api/v1/projects/${a.id}/rest/whoami`,
    );

    expect(response.status).toBe(502);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe("KB_PROJECT_RUNTIME_START_FAILED");
    expect(body.error.details).toEqual({ project: a.id });
    // Other projects are unaffected.
    const b = await registered();
    expect((await reply(subject, b.id, "/rest/whoami")).projectRoot).toBe(b.root);
  });

  it("answers KB_PROJECT_RUNTIME_LIMIT when every runtime slot is busy", async () => {
    const a = await registered();
    const b = await registered();
    const subject = await host({ maxActiveProjects: 1 });
    await reply(subject, a.id, "/rest/whoami");

    // A request that stays in flight keeps A's runtime busy.
    const slow = subject.fetchGateway(
      `/api/v1/projects/${a.id}/rest/slow?delay=1500`,
    );
    await waitFor(async () => {
      const health = (await (await subject.fetchGateway("/health")).json()) as HealthBody;
      return health.projectRuntimes.runtimes[0]?.inflight === 1;
    }, "the slow request to be in flight");

    const response = await subject.fetchGateway(
      `/api/v1/projects/${b.id}/rest/whoami`,
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as ErrorBody).error.code).toBe(
      "KB_PROJECT_RUNTIME_LIMIT");

    expect((await slow).status).toBe(200);
    // Once A is idle, B gets the slot.
    await waitFor(async () => {
      const retry = await subject.fetchGateway(
        `/api/v1/projects/${b.id}/rest/whoami`,
      );
      return retry.status === 200;
    }, "B to start once A is idle");
  });

  it("applies the gateway's authentication before a project runtime is ever started", async () => {
    const a = await registered();
    const subject = await host({ auth: "on" });

    const response = await subject.fetchGateway(
      `/api/v1/projects/${a.id}/rest/whoami`,
    );

    expect(response.status).toBe(401);
    // Public /health still answers, and nothing was started for the anonymous call.
    const health = (await (await subject.fetchGateway("/health")).json()) as HealthBody;
    expect(health.projectRuntimes.runtimes).toEqual([]);
  });

  it("is ready and healthy with no project runtime, and reflects runtimes once they start lazily", async () => {
    const a = await registered();
    const subject = await host({ maxActiveProjects: 3 });

    const before = await subject.fetchGateway("/ready");
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as ReadyBody;
    expect(beforeBody.ready).toBe(true);
    expect(beforeBody.components.projectRuntimes).toEqual({
      ready: true,
      status: "0/3 active",
    });

    await reply(subject, a.id, "/rest/whoami");

    const health = (await (await subject.fetchGateway("/health")).json()) as HealthBody;
    expect(health.projectRuntimes.limit).toBe(3);
    expect(health.projectRuntimes.active).toBe(1);
    expect(health.projectRuntimes.runtimes).toEqual([
      expect.objectContaining({ projectId: a.id, state: "ready", inflight: 0 }),
    ]);
    const after = (await (await subject.fetchGateway("/ready")).json()) as ReadyBody;
    expect(after.components.projectRuntimes?.status).toBe("1/3 active");
  });

  it("stops an idle runtime through the host", async () => {
    const a = await registered();
    const subject = await host({}, { idleTimeoutMs: 300, sweepIntervalMs: 50 });
    const { pid } = await reply(subject, a.id, "/rest/whoami");
    expect(isAlive(pid)).toBe(true);

    await waitFor(() => !isAlive(pid), "the idle runtime to stop");

    const health = (await (await subject.fetchGateway("/health")).json()) as HealthBody;
    expect(health.projectRuntimes.runtimes).toEqual([]);
    // The next request starts it again.
    const again = await reply(subject, a.id, "/rest/whoami");
    expect(again.pid).not.toBe(pid);
  });

  it("stops every project runtime when the host shuts down, leaving no orphans", async () => {
    const a = await registered();
    const b = await registered();
    const subject = await host();
    const pids = [
      (await reply(subject, a.id, "/rest/whoami")).pid,
      (await reply(subject, b.id, "/rest/whoami")).pid,
    ];
    const { childPid } = (await (
      await subject.fetchGateway(`/api/v1/projects/${a.id}/rest/__spawn-child`)
    ).json()) as { childPid: number };
    for (const pid of [...pids, childPid]) {
      expect(isAlive(pid)).toBe(true);
    }

    const exitCode = await subject.stop();

    expect(exitCode).toBe(0);
    for (const pid of [...pids, childPid]) {
      expect(isAlive(pid)).toBe(false);
    }
  });

  it("records the use of a project in the registry when its runtime starts", async () => {
    const a = await registered();
    const subject = await host();
    expect((await registry.get(a.id)).project.lastUsedAt).toBeNull();

    await reply(subject, a.id, "/rest/whoami");

    await waitFor(
      async () => (await registry.get(a.id)).project.lastUsedAt !== null,
      "lastUsedAt to be recorded",
    );
  });
});
