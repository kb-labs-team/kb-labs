import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createCatalogErrorEnvelope, type CatalogErrorRequest } from "@kb-labs/core-platform";
import { registerProjectRoutes } from "../project-routing.js";

const PROJECT_SERVICES = [{ serviceId: "rest", rewritePrefix: "/api/v1", healthCheck: "/health" }];

function catalogueText(request: CatalogErrorRequest): { message: string; hint: string } {
  const envelope = createCatalogErrorEnvelope(request);
  return { message: envelope.message, hint: envelope.hint };
}

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

  it("rejects duplicate or invalid service namespaces at Gateway assembly", async () => {
    app = Fastify();
    const transport = { resolveProjectService: async () => undefined };
    await expect(registerProjectRoutes(app, [
      { serviceId: "rest", rewritePrefix: "/api/v1", healthCheck: "/health" },
      { serviceId: "rest", rewritePrefix: "/api/v2", healthCheck: "/health" },
    ], transport)).rejects.toThrow(/duplicate project service id/i);
    await expect(registerProjectRoutes(app, [
      { serviceId: "rest/api", rewritePrefix: "/api/v1", healthCheck: "/health" },
    ], transport)).rejects.toThrow(/invalid project service id/i);
  });

  async function setup(transport: (port: number) => { resolveProjectService: (projectId: string, serviceId: string) => Promise<{ baseUrl: string; pathPrefix?: string; headers: Record<string, string>; release: () => void } | undefined> }, upstreamReply?: { statusCode: number; body: string; contentType?: string; headers?: Record<string, string>; stall?: boolean; stream?: boolean } | Array<{ statusCode: number; body: string; contentType?: string; headers?: Record<string, string>; stall?: boolean; stream?: boolean }>, services = PROJECT_SERVICES, timeoutMs = 30_000) {
    const seen: Array<{ url?: string; headers: Record<string, unknown>; body: string }> = [];
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
        const reply = Array.isArray(upstreamReply) ? upstreamReply[seen.length - 1] : upstreamReply;
        if (reply?.stall) return;
        if (reply?.stream) {
          res.writeHead(reply.statusCode, { "content-type": "text/event-stream" });
          res.write("data: open\\n\\n");
          return;
        }
        res.writeHead(reply?.statusCode ?? 202, {
          "x-up": "1",
          "content-type": reply?.contentType ?? "application/json",
          ...reply?.headers,
        });
        res.end(reply?.body ?? '"ok"');
      });
    });
    await new Promise<void>((resolve) => {
      upstream!.listen(0, "127.0.0.1", resolve);
    });
    const port = (upstream.address() as { port: number }).port;
    app = Fastify();
    await registerProjectRoutes(app, services, transport(port), timeoutMs);
    await app.ready();
    return seen;
  }

  it("rewrites the service namespace, replaces control headers and releases once", async () => {
    let released = 0;
    const seen = await setup((port) => ({
      resolveProjectService: async (id, serviceId) => {
        expect(id).toBe("prj_a");
        expect(serviceId).toBe("rest");
        return {
          baseUrl: `http://127.0.0.1:${port}`,
          pathPrefix: "/rest",
          headers: { "x-kb-runtime-token": "real" },
          release: () => {
            released += 1;
          },
        };
      },
    }));

    const res = await app!.inject({
      method: "POST",
      url: "/api/v1/projects/prj_a/rest/analytics/events?x=1",
      headers: { "x-kb-runtime-token": "forged", "content-type": "application/json" },
      payload: '{"a":1}',
    });

    expect(res.statusCode).toBe(202);
    expect(res.headers["x-up"]).toBe("1");
    expect(seen[0]?.url).toBe("/rest/api/v1/analytics/events?x=1");
    expect(seen[0]?.headers["x-kb-runtime-token"]).toBe("real");
    expect(seen[0]?.body).toBe('{"a":1}');
    expect(released).toBe(1);
  });

  it("routes the MCP service root without requiring a trailing slash", async () => {
    const seen = await setup((port) => ({
      resolveProjectService: async () => ({
        baseUrl: `http://127.0.0.1:${port}`,
        pathPrefix: "/mcp",
        headers: {},
        release: () => undefined,
      }),
    }), undefined, [{ serviceId: "mcp", rewritePrefix: "/", healthCheck: "/health" }]);

    const response = await app!.inject({ method: "POST", url: "/api/v1/projects/prj_a/mcp", payload: "{}" });

    expect(response.statusCode).toBe(202);
    expect(seen[0]?.url).toBe("/mcp/");
  });

  it("forwards the MCP service wire fixture through the project route byte-for-byte", async () => {
    const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../e2e/journey/fixtures/project-mcp-responses.json");
    const wireReplies: Array<{ step: string; status: number; headers: Record<string, string>; body: string }> =
      JSON.parse(await readFile(fixturePath, "utf8"));
    const seen = await setup((port) => ({
      resolveProjectService: async () => ({
        baseUrl: `http://127.0.0.1:${port}`,
        pathPrefix: "/mcp",
        headers: {},
        release: () => undefined,
      }),
    }), wireReplies.map(({ status, headers, body }) => ({
      statusCode: status,
      body,
      headers,
    })), [{ serviceId: "mcp", rewritePrefix: "/", healthCheck: "/health" }]);

    for (let index = 0; index < wireReplies.length; index += 1) {
      const reply = wireReplies[index]!;
      const response = await app!.inject({
        method: "POST",
        url: "/api/v1/projects/prj_fixture/mcp",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        payload: JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "test" }),
      });
      expect(response.statusCode).toBe(reply.status);
      for (const [name, value] of Object.entries(reply.headers)) {
        expect(response.headers[name]).toBe(value);
      }
      expect(response.rawPayload.toString("utf8")).toBe(reply.body);
    }
    expect(seen).toHaveLength(wireReplies.length);
  });

  // case: S-192.1
  it("returns the catalogued not-found error for an undeclared service without acquiring a runtime", async () => {
    let acquired = false;
    await setup(() => ({
      resolveProjectService: async () => {
        acquired = true;
        throw new Error("unknown service should not acquire a runtime");
      },
    }));

    const res = await app!.inject({
      method: "GET",
      url: "/api/v1/projects/prj_a/unknown-service/health",
    });

    expect(res.statusCode).toBe(404);
    const expectedText = catalogueText({ code: "KB_PROJECT_SERVICE_NOT_FOUND", details: {
      projectId: "prj_a",
      serviceId: "unknown-service",
    } });
    expect(res.json()).toMatchObject({
      ok: false,
      error: {
        code: "KB_PROJECT_SERVICE_NOT_FOUND",
        ...expectedText,
      },
    });
    expect(acquired).toBe(false);
  });

  // case: S-045.1
  it("returns an actionable MCP service envelope and releases when the runtime is unreachable", async () => {
    let released = 0;
    await setup(() => ({
      resolveProjectService: async () => ({ baseUrl: "http://127.0.0.1:1", pathPrefix: "/mcp", headers: {}, release: () => { released += 1; } }),
    }), undefined, [{ serviceId: "mcp", rewritePrefix: "/", healthCheck: "/health" }]);

    const res = await app!.inject({ method: "POST", url: "/api/v1/projects/p/mcp", payload: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });
    const expectedText = catalogueText({ code: "KB_PROJECT_RUNTIME_START_FAILED", details: {
      projectId: "p",
      serviceId: "mcp",
    } });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      ok: false,
      error: {
        code: "KB_PROJECT_RUNTIME_START_FAILED",
        ...expectedText,
        correlationId: expect.any(String),
      },
    });
    expect(released).toBe(1);
  });

  // case: S-045.1
  it("returns the same route envelope when project runtime resolution fails", async () => {
    await setup(() => ({
      resolveProjectService: async () => { throw new Error("private resolver detail"); },
    }), undefined, [{ serviceId: "mcp", rewritePrefix: "/", healthCheck: "/health" }]);

    const response = await app!.inject({ method: "POST", url: "/api/v1/projects/p/mcp", payload: "{}" });
    const expectedText = catalogueText({ code: "KB_PROJECT_RUNTIME_START_FAILED", details: {
      projectId: "p",
      serviceId: "mcp",
    } });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "KB_PROJECT_RUNTIME_START_FAILED",
        ...expectedText,
        correlationId: expect.any(String),
      },
    });
    expect(response.body).not.toContain("private resolver detail");
  });

  // case: S-045.1
  it("keeps catalogued project transport errors in the shared UX envelope", async () => {
    await setup(() => ({ resolveProjectService: async () => undefined }));

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/projects/p/rest/resource",
      payload: "{}",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "KB_HOST_SERVICE_ADDRESS_MISSING" },
    });
  });

  // case: PC-002.3, PC-002.8, S-124.11, S-124.13
  it("routes project health through the declared endpoint and wraps the payload", async () => {
    const seen = await setup((port) => ({
      resolveProjectService: async () => ({
        baseUrl: `http://127.0.0.1:${port}`,
        pathPrefix: "/rest",
        headers: {},
        release: () => undefined,
      }),
    }), { statusCode: 200, body: '{"schema":"kb.health/1","status":"healthy"}' });

    const response = await app!.inject({ method: "GET", url: "/api/v1/projects/prj_a/rest/health" });

    expect(seen[0]?.url).toBe("/rest/health");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { schema: "kb.health/1", status: "healthy" } });
  });

  // case: PC-002.8
  it("preserves the declared service health payload when it reports degraded", async () => {
    await setup((port) => ({
      resolveProjectService: async () => ({
        baseUrl: `http://127.0.0.1:${port}`,
        pathPrefix: "/rest",
        headers: {},
        release: () => undefined,
      }),
    }), { statusCode: 200, body: '{"schema":"kb.health/1","status":"degraded"}' });

    const response = await app!.inject({ method: "GET", url: "/api/v1/projects/prj_a/rest/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { schema: "kb.health/1", status: "degraded" } });
  });

  // case: S-226.1
  it("returns one actionable catalogued failure for unhealthy project health", async () => {
    await setup((port) => ({
      resolveProjectService: async () => ({
        baseUrl: `http://127.0.0.1:${port}`,
        pathPrefix: "/rest",
        headers: {},
        release: () => undefined,
      }),
    }), { statusCode: 200, body: '{"schema":"kb.health/1","status":"unhealthy"}' });

    const response = await app!.inject({ method: "GET", url: "/api/v1/projects/prj_a/rest/health" });
    const expectedText = catalogueText({ code: "KB_PROJECT_RUNTIME_START_FAILED", details: {
      projectId: "prj_a",
      serviceId: "rest",
    } });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "KB_PROJECT_RUNTIME_START_FAILED",
        ...expectedText,
      },
    });
  });

  // case: S-226.1
  it("returns one actionable catalogued failure when declared project health is unreachable", async () => {
    await setup(() => ({
      resolveProjectService: async () => ({
        baseUrl: "http://127.0.0.1:1",
        pathPrefix: "/rest",
        headers: {},
        release: () => undefined,
      }),
    }));

    const response = await app!.inject({ method: "GET", url: "/api/v1/projects/prj_a/rest/health" });
    const expectedText = catalogueText({ code: "KB_PROJECT_RUNTIME_START_FAILED", details: {
      projectId: "prj_a",
      serviceId: "rest",
    } });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "KB_PROJECT_RUNTIME_START_FAILED",
        ...expectedText,
      },
    });
  });

  // case: S-221.2
  it("times out a stalled upstream and releases its lease once", async () => {
    let released = 0;
    await setup(() => ({
      resolveProjectService: async () => ({ baseUrl: `http://127.0.0.1:${(upstream!.address() as { port: number }).port}`, pathPrefix: "/rest", headers: {}, release: () => { released += 1; } }),
    }), { statusCode: 200, body: "", stall: true }, PROJECT_SERVICES, 20);

    const response = await app!.inject({ method: "GET", url: "/api/v1/projects/p/rest/slow" });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "KB_RUNTIME_TIMEOUT" } });
    expect(released).toBe(1);
  });

  it("aborts a streaming upstream when the downstream client closes and releases once", async () => {
    let released = 0;
    let upstreamClosed = false;
    let resolveRelease!: () => void;
    const releasedLease = new Promise<void>((resolve) => { resolveRelease = resolve; });
    let resolveUpstreamClose!: () => void;
    const closedUpstream = new Promise<void>((resolve) => { resolveUpstreamClose = resolve; });
    upstream = createServer((req, res) => {
      res.on("close", () => { upstreamClosed = true; resolveUpstreamClose(); });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: open\\n\\n");
      });
      req.resume();
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as { port: number }).port;
    app = Fastify();
    await registerProjectRoutes(app, PROJECT_SERVICES, { resolveProjectService: async () => ({
      baseUrl: `http://127.0.0.1:${port}`, pathPrefix: "/rest", headers: {}, release: () => { released += 1; resolveRelease(); },
    }) });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP listener");
    await new Promise<void>((resolve, reject) => {
      const downstream = httpRequest({ host: "127.0.0.1", port: address.port, path: "/api/v1/projects/p/rest/events" }, (response) => {
        response.once("data", () => {
          downstream.destroy();
          resolve();
        });
      });
      downstream.once("error", (error) => {
        if (error.message === "socket hang up") resolve();
        else reject(error);
      });
      downstream.end();
    });
    await Promise.all([releasedLease, closedUpstream]);
    expect(released).toBe(1);
    expect(upstreamClosed).toBe(true);
  });

  // case: S-203.2
  it("wraps a non-envelope upstream 404 as a typed resource-not-found failure", async () => {
    await setup(() => ({
      resolveProjectService: async () => ({ baseUrl: `http://127.0.0.1:${(upstream!.address() as { port: number }).port}`, pathPrefix: "/rest", headers: {}, release: () => undefined }),
    }), { statusCode: 404, body: '{"error":"Not Found"}' });

    const res = await app!.inject({ method: "GET", url: "/api/v1/projects/p/rest/api/v1/plugins/agents/sessions" });

    expect(res.statusCode).toBe(404);
    const expectedText = catalogueText({ code: "KB_RUNTIME_RESOURCE_NOT_FOUND", details: {} });
    expect(res.json()).toMatchObject({
      ok: false,
      error: {
        code: "KB_RUNTIME_RESOURCE_NOT_FOUND",
        ...expectedText,
        details: { upstreamStatus: "404" },
        correlationId: expect.any(String),
      },
    });
  });

  // case: S-203.2
  it("wraps a non-envelope upstream 403 without inventing a permission detail", async () => {
    await setup((port) => ({
      resolveProjectService: async () => ({ baseUrl: `http://127.0.0.1:${port}`, pathPrefix: "/rest", headers: {}, release: () => undefined }),
    }), { statusCode: 403, body: '{"error":"Forbidden"}' });

    if (!app) throw new Error("project routing app was not initialized");
    const res = await app.inject({ method: "GET", url: "/api/v1/projects/p/rest/api/v1/private" });

    expect(res.statusCode).toBe(403);
    const expectedText = catalogueText({ code: "KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE", details: {} });
    expect(res.json()).toMatchObject({
      ok: false,
      error: {
        code: "KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE",
        ...expectedText,
        details: { requestStage: "GET /rest/api/v1/api/v1/private", httpStatus: "403" },
        correlationId: expect.any(String),
      },
    });
  });
});
