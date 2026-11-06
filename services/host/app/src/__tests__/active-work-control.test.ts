import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveWorkRegistry } from "@kb-labs/shared-daemon";
import { RUNTIME_TOKEN_HEADER } from "@kb-labs/project-runtime-app/protocol";
import { ProjectRuntimeManager, type RuntimeLauncher } from "../project-runtime/manager.js";
import { startHostActiveWorkControl } from "../active-work-control.js";
import { silentLogger } from "./testkit.js";

describe("host active-work control", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("aggregates registered host providers and authenticated project runtimes", async () => {
    const runtimeToken = "runtime-control-secret";
    const runtimeServer = createServer((request, response) => {
      if (request.url !== "/__runtime/active-work" || request.headers[RUNTIME_TOKEN_HEADER] !== runtimeToken) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ kind: "workflow", id: "project-run-1", owningService: "workflow" }]));
    });
    await new Promise<void>((resolve) => runtimeServer.listen(0, "127.0.0.1", resolve));
    const runtimeAddress = runtimeServer.address();
    if (!runtimeAddress || typeof runtimeAddress === "string") throw new Error("runtime fixture did not bind");
    cleanups.push(() => new Promise<void>((resolve, reject) => runtimeServer.close((error) => error ? reject(error) : resolve())));

    const launcher: RuntimeLauncher = {
      async launch() {
        return {
          pid: 1,
          address: { host: "127.0.0.1", port: runtimeAddress.port },
          token: runtimeToken,
          exited: new Promise(() => undefined),
          async stop() {},
          outputTail: () => "",
        };
      },
      async probe() { return true; },
    };
    const manager = new ProjectRuntimeManager({ launcher, logger: silentLogger(), maxActiveProjects: 2, idleTimeoutMs: 0, startTimeoutMs: 1000 });
    await manager.acquire({ id: "project-a", root: "/workspace/project-a" });
    cleanups.push(() => manager.stopAll());

    const providers = new ActiveWorkRegistry();
    providers.register("workflow", async () => [{ kind: "workflow", id: "platform-run-2" }]);
    const control = await startHostActiveWorkControl("host-control-secret-which-is-long-enough", providers, manager);
    cleanups.push(() => control.close());

    const response = await fetch(`${control.address}/v1/active-work`, { headers: { Authorization: "Bearer host-control-secret-which-is-long-enough" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { kind: "workflow", id: "project-run-1", owningService: "project:project-a/workflow" },
      { kind: "workflow", id: "platform-run-2", owningService: "workflow" },
    ]);
    expect((await fetch(`${control.address}/v1/active-work`)).status).toBe(403);
  });
});
