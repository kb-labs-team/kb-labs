/**
 * The runtime composition through the real `runHost` (real `launchPlatform`,
 * in-memory adapter fallbacks) with two minimal real modules standing in for
 * rest and workflow: what matters here is the wiring (generated loopback
 * ports, project-rooted platform, guard), not the services' own behavior.
 */

import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPlatformRuntime } from "@kb-labs/core-runtime";
import {
  canonicalizeProjectPath,
  deriveProjectId,
} from "@kb-labs/core-project-registry";
import { reserveLoopbackPorts, runHost } from "@kb-labs/shared-daemon";
import { createProjectRuntimeConfig, type ProjectRuntimeModule } from "../runtime.js";
import {
  RUNTIME_HEALTH_PATH,
  RUNTIME_TOKEN_HEADER,
  type RuntimeHealth,
} from "../protocol.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

/** A module that answers with what it was given: its port, host and project root. */
function echoModule(id: string): ProjectRuntimeModule {
  return {
    id,
    serviceId: id,
    setup: async (ctx) => {
      const server: Server = createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            module: id,
            projectRoot: ctx.projectRoot,
            port: ctx.port,
            host: ctx.host,
            url: req.url,
            projectHeader: req.headers["x-kb-project-id"] ?? null,
          }),
        );
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(ctx.port, ctx.host, resolve);
      });
      return () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        });
    },
  };
}

interface Running {
  base: string;
  root: string;
  projectId: string;
  stop(): Promise<number>;
}

const cleanups: Array<() => Promise<void>> = [];

async function startRuntime(options: {
  /** Environment the platform sees, on top of the isolated one. */
  env?: Record<string, string>;
} = {}): Promise<Running> {
  const dir = await mkdtemp(join(tmpdir(), "kb-runtime-config-"));
  await mkdir(join(dir, ".kb"), { recursive: true });
  const [guardPort] = await reserveLoopbackPorts(1);
  await writeFile(
    join(dir, ".kb", "kb.config.json"),
    JSON.stringify({
      platform: { adapters: {} },
    }),
  );
  const root = await canonicalizeProjectPath(dir);

  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined): void => {
    if (!saved.has(key)) {
      saved.set(key, process.env[key]);
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  setEnv("HOME", dir);
  setEnv("USERPROFILE", dir);
  for (const key of ["KB_NET_OFFSET", "KB_SOCKET_PATH", "KB_SOCKET_HASH", "KB_PLATFORM_ROOT"]) {
    setEnv(key, undefined);
  }
  setEnv("KB_PROJECT_ROOT", root);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    setEnv(key, value);
  }
  // Vitest workers have an IPC channel, which launchPlatform reads as "sandbox child".
  const send = process.send;
  process.send = undefined;

  const codes: number[] = [];
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    codes.push(typeof code === "number" ? code : 0);
    return undefined as never;
  });
  const termBefore = new Set(process.listeners("SIGTERM"));
  const intBefore = new Set(process.listeners("SIGINT"));
  resetPlatformRuntime();

  const cleanup = async (): Promise<void> => {
    resetPlatformRuntime();
    exitSpy.mockRestore();
    process.send = send;
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(dir, { recursive: true, force: true });
  };

  try {
    await runHost(
      await createProjectRuntimeConfig({
        projectRoot: root,
        projectId: deriveProjectId(root),
        listen: { host: "127.0.0.1", port: guardPort! },
        token: TOKEN,
        modules: [echoModule("rest"), echoModule("workflow")],
      }),
    );
  } catch (error) {
    await cleanup();
    throw error;
  }

  const handlers = process.listeners("SIGTERM").filter((l) => !termBefore.has(l));
  let stopped: Promise<number> | undefined;
  const running: Running = {
    base: `http://127.0.0.1:${guardPort}`,
    root,
    projectId: deriveProjectId(root),
    stop() {
      stopped ??= (async () => {
        for (const handler of handlers) {
          process.removeListener("SIGTERM", handler);
          await Reflect.apply(handler, process, []);
        }
        const deadline = Date.now() + 15_000;
        while (codes.length === 0 && Date.now() < deadline) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 20);
          });
        }
        for (const listener of process.listeners("SIGINT")) {
          if (!intBefore.has(listener)) {
            process.removeListener("SIGINT", listener);
          }
        }
        await cleanup();
        if (codes.length === 0) {
          throw new Error("runtime did not exit after SIGTERM");
        }
        return codes[0]!;
      })();
      return stopped;
    },
  };
  cleanups.push(() => running.stop().then(() => undefined));
  return running;
}

describe("project runtime composition (real runHost, minimal modules)", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup().catch(() => undefined)));
  });

  it("serves every module through the guard, on the project it was started for", async () => {
    const running = await startRuntime();
    const headers = { [RUNTIME_TOKEN_HEADER]: TOKEN };

    const rest = (await (await fetch(`${running.base}/rest/api/v1/x?y=1`, { headers })).json()) as Record<string, unknown>;
    const workflow = (await (await fetch(`${running.base}/workflow/runs`, { headers })).json()) as Record<string, unknown>;

    expect(await realpath(rest.projectRoot as string)).toBe(running.root);
    expect(await realpath(workflow.projectRoot as string)).toBe(running.root);
    expect(rest).toMatchObject({ module: "rest", url: "/api/v1/x?y=1", projectHeader: running.projectId });
    expect(workflow).toMatchObject({ module: "workflow", url: "/runs" });
    // Distinct ephemeral loopback ports, not the well-known ones.
    expect(rest.host).toBe("127.0.0.1");
    expect(workflow.host).toBe("127.0.0.1");
    expect(rest.port).not.toBe(workflow.port);
    for (const port of [rest.port, workflow.port]) {
      expect([4000, 5050, 5070, 7777, 7778]).not.toContain(port);
    }
  });

  it("reports itself healthy only once every module is up", async () => {
    const running = await startRuntime();

    const response = await fetch(`${running.base}${RUNTIME_HEALTH_PATH}`, {
      headers: { [RUNTIME_TOKEN_HEADER]: TOKEN },
    });

    expect(response.status).toBe(200);
    const health = (await response.json()) as RuntimeHealth;
    expect(health).toMatchObject({
      status: "ok",
      projectId: running.projectId,
      modules: { rest: "up", workflow: "up" },
    });
  });

  it("refuses requests without the secret", async () => {
    const running = await startRuntime();

    expect((await fetch(`${running.base}/rest/x`)).status).toBe(403);
    expect((await fetch(`${running.base}${RUNTIME_HEALTH_PATH}`)).status).toBe(403);
  });

  it("stops the guard and every module on SIGTERM and exits 0", async () => {
    const running = await startRuntime();
    expect(
      (await fetch(`${running.base}${RUNTIME_HEALTH_PATH}`, { headers: { [RUNTIME_TOKEN_HEADER]: TOKEN } })).status,
    ).toBe(200);

    expect(await running.stop()).toBe(0);

    await expect(
      fetch(`${running.base}${RUNTIME_HEALTH_PATH}`, { headers: { [RUNTIME_TOKEN_HEADER]: TOKEN } }),
    ).rejects.toThrow();
  });

  it("refuses to start when the platform resolves a different project root", async () => {
    const other = await mkdtemp(join(tmpdir(), "kb-runtime-other-"));
    await mkdir(join(other, ".kb"), { recursive: true });
    try {
      await expect(
        startRuntime({ env: { KB_PROJECT_ROOT: await realpath(other) } }),
      ).rejects.toThrow(/resolved project root/);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("refuses to start when KB_SOCKET_PATH would collapse the modules onto one socket", async () => {
    await expect(
      startRuntime({ env: { KB_SOCKET_PATH: join(tmpdir(), "kb-x.sock") } }),
    ).rejects.toThrow(/KB_SOCKET_PATH/);
  });
});
