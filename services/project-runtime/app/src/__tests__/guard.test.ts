import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createContextLogger } from "@kb-labs/core-platform";
import { NoOpLogger } from "@kb-labs/core-platform/noop";
import { reserveLoopbackPorts } from "@kb-labs/shared-daemon";
import { createRuntimeGuard, tokenMatches, type RuntimeGuard } from "../guard.js";
import {
  RUNTIME_HEALTH_PATH,
  RUNTIME_PROJECT_HEADER,
  RUNTIME_TOKEN_HEADER,
  type RuntimeHealth,
} from "../protocol.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const HOST = "127.0.0.1";

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

describe("runtime guard", () => {
  const servers: Server[] = [];
  let guard: RuntimeGuard | undefined;

  afterEach(async () => {
    await guard?.close();
    guard = undefined;
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function moduleServer(port: number, seen: Seen[]): Promise<void> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(201, { "content-type": "text/plain", "x-from-module": "yes" });
        res.end("module says hi");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(port, HOST, resolve);
    });
  }

  async function start(withModule: boolean): Promise<{ base: string; seen: Seen[] }> {
    const [guardPort, restPort, downPort] = await reserveLoopbackPorts(3);
    const seen: Seen[] = [];
    if (withModule) {
      await moduleServer(restPort!, seen);
    }
    guard = createRuntimeGuard({
      token: TOKEN,
      projectId: "prj_0123456789abcdef",
      projectRoot: "/some/project",
      modules: {
        rest: { host: HOST, port: restPort! },
        // Nothing listens here.
        workflow: { host: HOST, port: downPort! },
      },
      logger: createContextLogger(new NoOpLogger(), {
        applicationId: "guard-test",
        serviceId: "guard-test",
        instanceId: "test",
        layer: "service",
      }),
    });
    await guard.listen({ host: HOST, port: guardPort! });
    return { base: `http://${HOST}:${guardPort}`, seen };
  }

  const authed = { [RUNTIME_TOKEN_HEADER]: TOKEN };

  it("refuses every request without the exact secret", async () => {
    const { base, seen } = await start(true);

    for (const headers of [{}, { [RUNTIME_TOKEN_HEADER]: "wrong" }, { [RUNTIME_TOKEN_HEADER]: `${TOKEN}x` }]) {
      expect((await fetch(`${base}/rest/x`, { headers })).status).toBe(403);
      expect((await fetch(`${base}${RUNTIME_HEALTH_PATH}`, { headers })).status).toBe(403);
    }
    expect(seen).toEqual([]);
  });

  it("forwards /<module>/<path> with the module prefix stripped, and never forwards the secret", async () => {
    const { base, seen } = await start(true);

    const response = await fetch(`${base}/rest/api/v1/items?limit=2`, {
      method: "POST",
      headers: {
        ...authed,
        [RUNTIME_PROJECT_HEADER]: "prj_forged",
        "content-type": "application/json",
        "x-custom": "kept",
      },
      body: '{"a":1}',
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-from-module")).toBe("yes");
    expect(await response.text()).toBe("module says hi");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "/api/v1/items?limit=2",
      body: '{"a":1}',
    });
    expect(seen[0]?.headers[RUNTIME_TOKEN_HEADER]).toBeUndefined();
    expect(seen[0]?.headers[RUNTIME_PROJECT_HEADER]).toBe("prj_0123456789abcdef");
    expect(seen[0]?.headers["x-custom"]).toBe("kept");
  });

  it("maps the bare module path to the module root", async () => {
    const { base, seen } = await start(true);

    await fetch(`${base}/rest`, { headers: authed });

    expect(seen[0]?.url).toBe("/");
  });

  it("answers unknown modules with 404 and a down module with 502", async () => {
    const { base } = await start(true);

    expect((await fetch(`${base}/nope/x`, { headers: authed })).status).toBe(404);
    expect((await fetch(`${base}/workflow/x`, { headers: authed })).status).toBe(502);
  });

  it("reports identity and per-module reachability on the health path", async () => {
    const { base } = await start(true);

    const response = await fetch(`${base}${RUNTIME_HEALTH_PATH}`, { headers: authed });

    // workflow is down in this fixture, so the runtime is degraded (503).
    expect(response.status).toBe(503);
    const body = (await response.json()) as RuntimeHealth;
    expect(body).toMatchObject({
      status: "degraded",
      projectId: "prj_0123456789abcdef",
      projectRoot: "/some/project",
      pid: process.pid,
      modules: { rest: "up", workflow: "down" },
    });
  });

  it("does not proxy WebSocket upgrades yet", async () => {
    const { base } = await start(true);
    const url = new URL(base);

    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: url.hostname, port: Number(url.port) });
      let data = "";
      socket.on("connect", () => {
        socket.write(
          `GET /rest/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${RUNTIME_TOKEN_HEADER}: ${TOKEN}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
      });
      socket.on("end", () => resolve(data.split("\r\n")[0] ?? ""));
      socket.on("error", reject);
    });

    expect(status).toContain("501");
  });
});

describe("tokenMatches", () => {
  it("is true only for the identical string", () => {
    expect(tokenMatches("secret", "secret")).toBe(true);
    expect(tokenMatches("secret", "secreT")).toBe(false);
    expect(tokenMatches("secret", "")).toBe(false);
    expect(tokenMatches("secret", undefined)).toBe(false);
    expect(tokenMatches("secret", ["secret"])).toBe(false);
  });
});
