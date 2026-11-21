/**
 * The runtime composition through the real `runHost` (real `launchPlatform`,
 * in-memory adapter fallbacks) with two minimal real modules standing in for
 * rest and workflow: what matters here is the wiring (generated loopback
 * ports, project-rooted platform, guard), not the services' own behavior.
 */

import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetPlatformRuntime } from "@kb-labs/core-runtime";
import {
  canonicalizeProjectPath,
  createProjectRegistry,
  deriveProjectId,
} from "@kb-labs/core-project-registry";
import { reserveLoopbackPorts, runHost } from "@kb-labs/shared-daemon";
import { buildServiceTools, mcpToolName } from "@kb-labs/mcp-app/project-module";
import {
  createProjectRuntimeConfig,
  DEFAULT_PROJECT_MODULES,
  type ProjectRuntimeModule,
} from "../runtime.js";
import {
  RUNTIME_HEALTH_PATH,
  RUNTIME_TOKEN_HEADER,
  type RuntimeHealth,
} from "../protocol.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
let launcherModuleUrl: string;
let launcherFixtureRoot: string;

beforeAll(async () => {
  launcherFixtureRoot = await mkdtemp(join(tmpdir(), "kb-runtime-launcher-"));
  const launcherPath = join(launcherFixtureRoot, "bin.js");
  await mkdir(join(launcherFixtureRoot, ".kb"), { recursive: true });
  await writeFile(launcherPath, "");
  await writeFile(
    join(launcherFixtureRoot, ".kb", "kb.config.json"),
    JSON.stringify({ platform: { deployment: { topology: "local" }, adapters: {} } }),
  );
  await writeFile(
    join(launcherFixtureRoot, ".kb-platform-launch.json"),
    JSON.stringify({ launchers: [relative(launcherFixtureRoot, launcherPath)] }),
  );
  launcherModuleUrl = pathToFileURL(launcherPath).href;
});

afterAll(async () => {
  await rm(launcherFixtureRoot, { recursive: true, force: true });
});

describe("project MCP service tools", () => {
  it("projects tools from enabled shipped service manifests and removes them when workflow is disabled", () => {
    const enabledManifests = DEFAULT_PROJECT_MODULES.map((module) => module.manifest);
    const enabledNames = buildServiceTools(enabledManifests).map((tool) => tool.name);
    expect(enabledNames).toContain(mcpToolName("workflow", "workflow run"));

    const disabledManifests = enabledManifests.filter((manifest) => manifest.id !== "workflow");
    const disabledNames = buildServiceTools(disabledManifests).map((tool) => tool.name);
    expect(disabledNames).not.toContain(mcpToolName("workflow", "workflow run"));
    expect(disabledNames.some((name) => name.startsWith("workflow__"))).toBe(false);
  });

  // case: S-045.11
  it("serves the generated service catalog without workflow when its manifest is omitted", async () => {
    const modules = DEFAULT_PROJECT_MODULES.filter((module) => module.manifest.id !== "workflow");
    const manifests = modules.map((module) => module.manifest);
    const expectedServiceNames = buildServiceTools(manifests).map((tool) => tool.name).sort();
    const servicePrefixes = DEFAULT_PROJECT_MODULES.map((module) =>
      mcpToolName(module.manifest.id, ""),
    );
    const workflowPrefix = mcpToolName("workflow", "");
    const running = await startRuntime({ modules, env: { KB_MCP_AUTH_MODE: "local" } });

    try {
      const response = await fetch(`${running.base}/mcp/`, {
        method: "POST",
        headers: {
          [RUNTIME_TOKEN_HEADER]: TOKEN,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(response.status).toBe(200);
      const responseText = await response.text();
      const frame = responseText.split("\ndata: ")[1]?.trim();
      expect(frame).toBeDefined();
      const rpcResult = JSON.parse(frame ?? "{}");
      const tools = rpcResult.result.tools as Array<{ name: string }>;
      const servedServiceNames = tools
        .map((tool) => tool.name)
        .filter((name) => servicePrefixes.some((prefix) => name.startsWith(prefix)))
        .sort();

      expect(servedServiceNames).toEqual(expectedServiceNames);
      expect(tools.some((tool) => tool.name.startsWith(workflowPrefix))).toBe(false);
    } finally {
      await running.stop();
    }
  });
});

describe("project MCP calls over the HTTP service transport", () => {
  // case: S-045.2
  it("sends empty and filtered GET tool calls without a request body", async () => {
    const service: ProjectRuntimeModule = {
      manifest: {
        schema: "kb.service/1",
        id: "catalog",
        name: "Catalog",
        version: "1.0.0",
        runtime: { entry: "dist/bin.js", healthCheck: "/health" },
        projectApi: { serviceId: "catalog", rewritePrefix: "/api/v1" },
        commands: [
          {
            kind: "service", name: "catalog health", description: "Health", scope: "project",
            jsonTest: {}, category: "catalog", flags: {},
            route: { method: "GET", path: "/health", mount: "service-root" },
          },
          {
            kind: "service", name: "catalog list", description: "List", scope: "project",
            jsonTest: {}, category: "catalog", flags: { filter: { type: "string" } },
            route: { method: "GET", path: "/items", mount: "project-api" },
          },
        ],
      },
      setup: async (ctx) => {
        const server: Server = createServer(async (req, res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {chunks.push(Buffer.from(chunk));}
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() }));
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(ctx.port, ctx.host, resolve);
        });
        return () => new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        });
      },
    };
    const mcp = DEFAULT_PROJECT_MODULES.find((module) => module.manifest.projectApi?.serviceId === "mcp");
    expect(mcp).toBeDefined();
    const running = await startRuntime({ modules: [service, mcp!], env: { KB_MCP_AUTH_MODE: "local" } });
    try {
      for (const params of [
        { name: "catalog__catalog_health", arguments: {} },
        { name: "catalog__catalog_list", arguments: { filter: "recent" } },
      ]) {
        const response = await fetch(`${running.base}/mcp/`, {
          method: "POST",
          headers: {
            [RUNTIME_TOKEN_HEADER]: TOKEN,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
        });
        expect(response.status).toBe(200);
        const responseText = await response.text();
        const frame = responseText.split("\ndata: ")[1]?.trim();
        expect(frame).toBeDefined();
        const rpcResult = JSON.parse(frame ?? "{}");
        const serviceResult = JSON.parse(rpcResult.result.content[0].text);
        expect(serviceResult.body).toBe("");
        if (params.name === "catalog__catalog_list") {
          expect(serviceResult.url).toBe("/api/v1/items?filter=recent");
        }
      }
    } finally {
      await running.stop();
    }
  });
});

/** A module that answers with what it was given: its port, host and project root. */
function echoModule(id: string): ProjectRuntimeModule {
  return {
    manifest: {
      schema: "kb.service/1",
      id,
      name: id,
      version: "1.0.0",
      runtime: { entry: "dist/bin.js", healthCheck: "/health" },
      projectApi: { serviceId: id, rewritePrefix: "/api/v1" },
    },
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
  modules?: readonly ProjectRuntimeModule[];
} = {}): Promise<Running> {
  const dir = await mkdtemp(join(tmpdir(), "kb-runtime-config-"));
  await mkdir(join(dir, ".kb"), { recursive: true });
  const [guardPort] = await reserveLoopbackPorts(1);
  await writeFile(
    join(dir, ".kb", "kb.config.json"),
    JSON.stringify({
      platform: { deployment: { topology: "local" }, adapters: {} },
    }),
  );
  const root = await canonicalizeProjectPath(dir);
  const kbHome = join(dir, "kb-home");
  await mkdir(kbHome, { recursive: true });
  await createProjectRegistry({ root: kbHome }).add(root);

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
  setEnv("KB_HOME", kbHome);
  for (const key of ["KB_NET_OFFSET", "KB_SOCKET_PATH", "KB_SOCKET_HASH", "KB_PLATFORM_ROOT", "KB_PROJECT_ID"]) {
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
        modules: options.modules ?? [echoModule("rest"), echoModule("workflow")],
        moduleUrl: launcherModuleUrl,
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

  it("starts the real workflow module with the registered project identity", async () => {
    const running = await startRuntime({ modules: DEFAULT_PROJECT_MODULES });
    const response = await fetch(`${running.base}${RUNTIME_HEALTH_PATH}`, {
      headers: { [RUNTIME_TOKEN_HEADER]: TOKEN },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      projectId: running.projectId,
      modules: { rest: "up", workflow: "up", mcp: "up" },
    });
  });

  it("releases the resolve hook after a first-module startup failure", async () => {
    const failingModule: ProjectRuntimeModule = {
      ...echoModule("rest"),
      setup: async () => {
        throw new Error("injected project module startup failure");
      },
    };

    await expect(startRuntime({ modules: [failingModule] })).rejects.toThrow(
      "injected project module startup failure",
    );
    const running = await startRuntime();
    await running.stop();
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

  // case: S-124.11
  it("serves the explicit registered project when the platform root differs", async () => {
    const other = await mkdtemp(join(tmpdir(), "kb-runtime-other-"));
    await mkdir(join(other, ".kb"), { recursive: true });
    await writeFile(join(other, ".kb", "kb.config.json"), JSON.stringify({
      platform: { deployment: { topology: "local" }, adapters: {} },
    }));
    try {
      const running = await startRuntime({ env: {
          KB_PROJECT_ROOT: await realpath(other),
          KB_PLATFORM_ROOT: await realpath(other),
      } });
      try {
        const response = await fetch(`${running.base}${RUNTIME_HEALTH_PATH}`, {
          headers: { [RUNTIME_TOKEN_HEADER]: TOKEN },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          projectId: running.projectId,
          projectRoot: running.root,
        });
      } finally {
        await running.stop();
      }
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  // case: S-124.11
  it("declares the registered project identity on the runtime process config", async () => {
    const project = await mkdtemp(join(tmpdir(), "kb-runtime-identity-"));
    try {
      const root = await canonicalizeProjectPath(project);
      const config = await createProjectRuntimeConfig({
        projectRoot: root,
        projectId: deriveProjectId(root),
        listen: { host: "127.0.0.1", port: 51234 },
        token: TOKEN,
        modules: [],
      });

      expect(config).toMatchObject({
        projectScope: "required",
        projectId: deriveProjectId(root),
        startDir: root,
      });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("refuses to start when KB_SOCKET_PATH would collapse the modules onto one socket", async () => {
    await expect(
      startRuntime({ env: { KB_SOCKET_PATH: join(tmpdir(), "kb-x.sock") } }),
    ).rejects.toThrow(/KB_SOCKET_PATH/);
  });
});
