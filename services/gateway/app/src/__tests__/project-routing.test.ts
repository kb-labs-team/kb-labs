import { createServer, type Server } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createErrorEnvelope } from "@kb-labs/core-platform";
import {
  ProjectRoutingError,
  registerProjectRoutes,
  type ProjectRouting,
} from "../project-routing.js";

describe("registerProjectRoutes", () => {
  let upstream: Server | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    await new Promise<void>((resolve) => {
      if (!upstream) {
        resolve();
        return;
      }
      upstream.closeAllConnections();
      upstream.close(() => resolve());
    });
    upstream = undefined;
    app = undefined;
  });

  async function setup(routing: (port: number) => ProjectRouting) {
    const seen: Array<{ url?: string; headers: Record<string, unknown>; body: string }> = [];
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(202, { "x-up": "1" });
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => {
      upstream!.listen(0, "127.0.0.1", resolve);
    });
    const port = (upstream.address() as { port: number }).port;
    app = Fastify();
    await registerProjectRoutes(app, routing(port));
    await app.ready();
    return seen;
  }

  it("forwards the remainder of the path, replaces control headers and releases once", async () => {
    let released = 0;
    const seen = await setup((port) => ({
      status: () => ({ limit: 1, active: 0, runtimes: [] }),
      acquire: async (id) => {
        expect(id).toBe("prj_a");
        return {
          host: "127.0.0.1",
          port,
          headers: { "x-kb-runtime-token": "real" },
          release: () => {
            released += 1;
          },
        };
      },
    }));

    const res = await app!.inject({
      method: "POST",
      url: "/api/v1/projects/prj_a/rest/items?x=1",
      headers: { "x-kb-runtime-token": "forged", "content-type": "application/json" },
      payload: '{"a":1}',
    });

    expect(res.statusCode).toBe(202);
    expect(res.headers["x-up"]).toBe("1");
    expect(seen[0]?.url).toBe("/rest/items?x=1");
    expect(seen[0]?.headers["x-kb-runtime-token"]).toBe("real");
    expect(seen[0]?.body).toBe('{"a":1}');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(released).toBe(1);
  });

  it("maps catalog errors to statuses", async () => {
    await setup(() => ({
      status: () => ({ limit: 1, active: 0, runtimes: [] }),
      acquire: async (id) => {
        const code =
          id === "u" ? "KB_PROJECT_UNKNOWN" : id === "l" ? "KB_PROJECT_RUNTIME_LIMIT" : "KB_PROJECT_RUNTIME_START_FAILED";
        throw new ProjectRoutingError(createErrorEnvelope(code, { details: { path: id, limit: "1", project: id } }));
      },
    }));

    for (const [id, status, code] of [
      ["u", 404, "KB_PROJECT_UNKNOWN"],
      ["l", 503, "KB_PROJECT_RUNTIME_LIMIT"],
      ["s", 502, "KB_PROJECT_RUNTIME_START_FAILED"],
    ] as const) {
      const res = await app!.inject({ method: "GET", url: `/api/v1/projects/${id}/rest/x` });
      expect(res.statusCode).toBe(status);
      expect(res.json().error.code).toBe(code);
    }
  });

  it("answers 502 and releases when the runtime is unreachable", async () => {
    let released = 0;
    await setup(() => ({
      status: () => ({ limit: 1, active: 0, runtimes: [] }),
      acquire: async () => ({ host: "127.0.0.1", port: 1, headers: {}, release: () => { released += 1; } }),
    }));

    const res = await app!.inject({ method: "GET", url: "/api/v1/projects/p/rest/x" });

    expect(res.statusCode).toBe(502);
    expect(released).toBe(1);
  });
});
