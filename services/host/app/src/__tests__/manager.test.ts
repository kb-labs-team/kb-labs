import { afterEach, describe, expect, it } from "vitest";
import { createChildProcessLauncher } from "../project-runtime/launcher.js";
import { ProjectRuntimeError } from "../project-runtime/errors.js";
import {
  ProjectRuntimeManager,
  type ProjectRuntimeManagerOptions,
  type RuntimeLauncher,
  type RuntimeProject,
} from "../project-runtime/manager.js";
import {
  callRuntime,
  FAKE_RUNTIME_ENTRY,
  isAlive,
  makeProject,
  silentLogger,
  waitFor,
  type FakeRuntimeReply,
  type TestProject,
} from "./testkit.js";

/** The real child-process launcher, counting how often it is asked to launch. */
function countingLauncher(): RuntimeLauncher & { launches: number } {
  const inner = createChildProcessLauncher({
    entry: FAKE_RUNTIME_ENTRY,
    stopTimeoutMs: 1500,
  });
  const counted = {
    launches: 0,
    launch(project: RuntimeProject) {
      counted.launches += 1;
      return inner.launch(project);
    },
    probe: inner.probe,
  };
  return counted;
}

async function expectRuntimeError(
  promise: Promise<unknown>,
  code: string,
): Promise<ProjectRuntimeError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ProjectRuntimeError);
  const runtimeError = error as ProjectRuntimeError;
  expect(runtimeError.envelope.code).toBe(code);
  return runtimeError;
}

describe("ProjectRuntimeManager (real child processes, fake runtime script)", () => {
  const projects: TestProject[] = [];
  const managers: ProjectRuntimeManager[] = [];

  async function project(
    behavior: Parameters<typeof makeProject>[0] = {},
  ): Promise<TestProject> {
    const created = await makeProject(behavior);
    projects.push(created);
    return created;
  }

  function manager(
    overrides: Partial<ProjectRuntimeManagerOptions> = {},
    launcher: RuntimeLauncher = countingLauncher(),
  ): ProjectRuntimeManager {
    const created = new ProjectRuntimeManager({
      launcher,
      logger: silentLogger(),
      maxActiveProjects: 4,
      idleTimeoutMs: 0,
      startTimeoutMs: 10_000,
      startPollMs: 20,
      ...overrides,
    });
    managers.push(created);
    return created;
  }

  function pidOf(subject: ProjectRuntimeManager, projectId: string): number {
    const pid = subject
      .status()
      .runtimes.find((runtime) => runtime.projectId === projectId)?.pid;
    if (pid === undefined) {
      throw new Error(`no runtime pid for ${projectId}`);
    }
    return pid;
  }

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.stopAll()));
    await Promise.all(projects.splice(0).map((p) => p.cleanup()));
  });

  it("starts a runtime lazily on the first request and answers as that project", async () => {
    const a = await project();
    const subject = manager();

    expect(subject.status().runtimes).toEqual([]);

    const lease = await subject.acquire(a);
    const reply = (await (
      await callRuntime(lease, "/rest/hello?x=1")
    ).json()) as FakeRuntimeReply;

    expect(reply.projectRoot).toBe(a.root);
    expect(reply.projectId).toBe(a.id);
    expect(reply.path).toBe("/rest/hello");
    expect(lease.address.host).toBe("127.0.0.1");
    expect(lease.address.port).toBeGreaterThan(1023);
    const [entry] = subject.status().runtimes;
    expect(entry).toMatchObject({ projectId: a.id, state: "ready", inflight: 1 });
    lease.release();
  });

  it("reuses a running runtime and starts it once for concurrent first requests", async () => {
    const a = await project();
    const launcher = countingLauncher();
    const subject = manager({}, launcher);

    const leases = await Promise.all([
      subject.acquire(a),
      subject.acquire(a),
      subject.acquire(a),
    ]);
    const later = await subject.acquire(a);

    expect(launcher.launches).toBe(1);
    expect(new Set([...leases, later].map((l) => l.address.port)).size).toBe(1);
    expect(subject.status().runtimes[0]?.inflight).toBe(4);
    for (const lease of [...leases, later]) {
      lease.release();
      lease.release(); // idempotent
    }
    expect(subject.status().runtimes[0]?.inflight).toBe(0);
  });

  it("rejects a runtime that never speaks the secret protocol", async () => {
    const a = await project();
    const subject = manager();
    const lease = await subject.acquire(a);

    const anonymous = await fetch(
      `http://${lease.address.host}:${lease.address.port}/rest/hello`,
    );
    expect(anonymous.status).toBe(403);
    const wrong = await fetch(
      `http://${lease.address.host}:${lease.address.port}/rest/hello`,
      { headers: { "x-kb-runtime-token": "not-the-secret" } },
    );
    expect(wrong.status).toBe(403);
    lease.release();
  });

  it("stops an idle runtime after the idle timeout but never one with a request in flight", async () => {
    const a = await project();
    const b = await project();
    const subject = manager({ idleTimeoutMs: 400, sweepIntervalMs: 50 });

    const busy = await subject.acquire(a);
    const idle = await subject.acquire(b);
    const idlePid = pidOf(subject, b.id);
    const busyPid = pidOf(subject, a.id);
    idle.release();

    await waitFor(() => !isAlive(idlePid), "the idle runtime to stop");
    expect(subject.status().runtimes.map((r) => r.projectId)).toEqual([a.id]);
    // The busy one outlived several idle periods.
    expect(isAlive(busyPid)).toBe(true);

    busy.release();
    await waitFor(() => !isAlive(busyPid), "the released runtime to stop");
    expect(subject.status().runtimes).toEqual([]);
  });

  it("starts a stopped project again on its next request", async () => {
    const a = await project();
    const subject = manager({ idleTimeoutMs: 200, sweepIntervalMs: 50 });

    const first = await subject.acquire(a);
    const firstPid = pidOf(subject, a.id);
    first.release();
    await waitFor(() => !isAlive(firstPid), "idle stop");

    const second = await subject.acquire(a);
    expect(pidOf(subject, a.id)).not.toBe(firstPid);
    expect(second.address.port).toBeGreaterThan(0);
    second.release();
  });

  it("evicts the least recently used idle runtime when the limit is reached", async () => {
    const [a, b, c] = [await project(), await project(), await project()] as [
      TestProject,
      TestProject,
      TestProject,
    ];
    const subject = manager({ maxActiveProjects: 2 });

    (await subject.acquire(a)).release();
    (await subject.acquire(b)).release();
    const pidA = pidOf(subject, a.id);
    const pidB = pidOf(subject, b.id);
    // Use A again, so B is now the least recently used.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
    (await subject.acquire(a)).release();

    const lease = await subject.acquire(c);

    expect(isAlive(pidB)).toBe(false);
    expect(isAlive(pidA)).toBe(true);
    expect(subject.status().runtimes.map((r) => r.projectId).sort()).toEqual(
      [a.id, c.id].sort(),
    );
    expect(subject.status().active).toBe(2);
    lease.release();
  });

  it("fails with KB_PROJECT_RUNTIME_LIMIT when every runtime is busy", async () => {
    const a = await project();
    const b = await project();
    const subject = manager({ maxActiveProjects: 1 });
    const busy = await subject.acquire(a);
    const pidA = pidOf(subject, a.id);

    const error = await expectRuntimeError(
      subject.acquire(b),
      "KB_PROJECT_RUNTIME_LIMIT",
    );

    expect(error.envelope.details).toEqual({ limit: "1" });
    expect(error.envelope.message).toContain("1");
    expect(isAlive(pidA)).toBe(true);
    expect(subject.status().runtimes).toHaveLength(1);
    busy.release();
    // Now A is idle, so B may take its slot.
    (await subject.acquire(b)).release();
    expect(isAlive(pidA)).toBe(false);
  });

  it("never exceeds the limit when new projects arrive at the same time", async () => {
    const all = await Promise.all([project(), project(), project(), project()]);
    const subject = manager({ maxActiveProjects: 2 });

    const results = await Promise.allSettled(all.map((p) => subject.acquire(p)));

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(2);
    expect(subject.status().active).toBeLessThanOrEqual(2);
    for (const result of results) {
      if (result.status === "rejected") {
        expect((result.reason as ProjectRuntimeError).envelope.code).toBe(
          "KB_PROJECT_RUNTIME_LIMIT",
        );
      } else {
        result.value.release();
      }
    }
  });

  it("restarts a crashed runtime with backoff and serves the next request", async () => {
    const a = await project();
    const subject = manager({
      restart: { baseDelayMs: 20, maxDelayMs: 100 },
    });
    const lease = await subject.acquire(a);
    const firstPid = pidOf(subject, a.id);
    lease.release();

    // The runtime dies while answering this request.
    const held = await subject.acquire(a);
    await callRuntime(held, "/rest/__crash").catch(() => undefined);
    held.release();
    await waitFor(() => !isAlive(firstPid), "the crashed runtime to be gone");

    const again = await subject.acquire(a);
    const reply = (await (
      await callRuntime(again, "/rest/hello")
    ).json()) as FakeRuntimeReply;
    expect(reply.projectRoot).toBe(a.root);
    expect(reply.pid).not.toBe(firstPid);
    expect(subject.status().runtimes[0]).toMatchObject({
      state: "ready",
      restarts: 1,
    });
    again.release();
  });

  it("gives up after the restart attempts are used up, then starts fresh on the next request", async () => {
    const a = await project();
    const subject = manager({
      restart: { baseDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 },
    });
    const lease = await subject.acquire(a);
    lease.release();

    // From now on the runtime cannot come back up.
    await a.behave({ exitBeforeReady: 9 });
    const held = await subject.acquire(a);
    await callRuntime(held, "/rest/__crash").catch(() => undefined);
    held.release();

    await waitFor(
      () => subject.status().runtimes[0]?.state === "failed",
      "the runtime to be given up",
    );
    const failed = subject.status().runtimes[0];
    expect(failed?.lastError).toContain("gave up after 2 restarts");

    await a.behave({});
    const revived = await subject.acquire(a);
    expect(subject.status().runtimes[0]?.state).toBe("ready");
    revived.release();
  });

  it("kills and restarts a runtime that stops answering health checks", async () => {
    const a = await project({ unhealthyAfterMs: 600 });
    const subject = manager({
      healthIntervalMs: 60,
      healthFailureThreshold: 2,
      restart: { baseDelayMs: 10, maxDelayMs: 20 },
    });
    (await subject.acquire(a)).release();
    const firstPid = pidOf(subject, a.id);

    await waitFor(() => !isAlive(firstPid), "the unhealthy runtime to be killed");
    await waitFor(
      () => subject.status().runtimes[0]?.state === "ready" &&
        subject.status().runtimes[0]?.pid !== firstPid,
      "a replacement runtime",
    );
    expect(subject.status().runtimes[0]?.restarts).toBeGreaterThanOrEqual(1);
  });

  it("reports KB_PROJECT_RUNTIME_START_FAILED with the cause when the process exits during start", async () => {
    const a = await project({ exitBeforeReady: 3 });
    const subject = manager();

    const error = await expectRuntimeError(
      subject.acquire(a),
      "KB_PROJECT_RUNTIME_START_FAILED",
    );

    expect(error.envelope.details).toEqual({ project: a.id });
    expect(error.envelope.cause).toContain("code 3");
    expect(error.envelope.cause).toContain("refusing to start");
    expect(subject.status().runtimes[0]).toMatchObject({ state: "failed" });
    expect(subject.status().active).toBe(0);
    // A failed project does not hold a slot and can be tried again.
    await a.behave({});
    (await subject.acquire(a)).release();
  });

  it("reports a start failure when the runtime is not healthy in time, and leaves no process", async () => {
    const a = await project({ startDelayMs: 5000 });
    const subject = manager({ startTimeoutMs: 400 });

    const error = await expectRuntimeError(
      subject.acquire(a),
      "KB_PROJECT_RUNTIME_START_FAILED",
    );

    expect(error.envelope.cause).toContain("not healthy within 400 ms");
    expect(subject.status().active).toBe(0);
  });

  it("stops every runtime on shutdown, including processes they spawned", async () => {
    const [a, b] = [await project(), await project()] as [TestProject, TestProject];
    const subject = manager();
    const leaseA = await subject.acquire(a);
    const leaseB = await subject.acquire(b);
    const pids = [pidOf(subject, a.id), pidOf(subject, b.id)];
    const { childPid } = (await (
      await callRuntime(leaseA, "/rest/__spawn-child")
    ).json()) as { childPid: number };
    expect(isAlive(childPid)).toBe(true);
    // Requests are still in flight: shutdown does not wait for them.
    expect(leaseB.projectId).toBe(b.id);

    await subject.stopAll();

    for (const pid of [...pids, childPid]) {
      expect(isAlive(pid)).toBe(false);
    }
    expect(subject.status().runtimes).toEqual([]);
    await expectRuntimeError(
      subject.acquire(a),
      "KB_PROJECT_RUNTIME_START_FAILED",
    );
  });

  it("kills a runtime that ignores SIGTERM", async () => {
    const a = await project({ ignoreSigterm: true });
    const subject = manager();
    (await subject.acquire(a)).release();
    const pid = pidOf(subject, a.id);

    await subject.stopAll();

    expect(isAlive(pid)).toBe(false);
  });

  it("stops a runtime that is still starting when the host shuts down", async () => {
    const a = await project({ startDelayMs: 1500 });
    const subject = manager();
    const pending = subject
      .acquire(a)
      .then(() => undefined, (error: unknown) => error);
    await waitFor(
      () => subject.status().runtimes.some((r) => r.state === "starting" && r.pid !== undefined),
      "the runtime process to be spawned",
    );
    const pid = pidOf(subject, a.id);

    await subject.stopAll();

    expect(isAlive(pid)).toBe(false);
    expect(await pending).toBeInstanceOf(ProjectRuntimeError);
  });
});
