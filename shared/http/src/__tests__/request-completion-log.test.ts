import { afterEach, describe, expect, it, vi } from "vitest";
import type { ILogger } from "@kb-labs/core-platform";
import { createDaemonServer } from "../daemon-server.js";
import { SLOW_REQUEST_THRESHOLD_MS } from "../request-completion-log.js";

interface Recorded {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

function recordingLogger(records: Recorded[]): ILogger {
  const logger: ILogger = {
    trace: vi.fn(),
    debug: (message, fields) => void records.push({ level: "debug", message, fields }),
    info: (message, fields) => void records.push({ level: "info", message, fields }),
    warn: (message, fields) => void records.push({ level: "warn", message, fields }),
    error: vi.fn(),
    fatal: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    child: () => logger,
  };
  return logger;
}

const observability = {
  register: vi.fn(),
  buildDescribe: vi.fn(),
  buildHealth: vi.fn().mockReturnValue({ status: "healthy" }),
  renderPrometheusMetrics: vi.fn().mockReturnValue(""),
};

describe("request-completion log policy (x279)", () => {
  const servers: Awaited<ReturnType<typeof createDaemonServer>>[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function make(records: Recorded[]) {
    const server = await createDaemonServer({
      serviceId: "policy-test",
      logger: recordingLogger(records),
      observability,
      registerRoutes: async (s) => {
        s.get("/business", async () => ({ ok: true }));
        s.get("/probe", { config: { kbRequestKind: "probe" } }, async () => ({ ok: true }));
        s.get("/poll", { config: { kbRequestKind: "polling" } }, async () => ({ ok: true }));
        s.get("/probe-boom", { config: { kbRequestKind: "probe" } }, async (_req, reply) =>
          reply.code(500).send({ error: "boom" }),
        );
        s.get("/boom", async (_req, reply) => reply.code(500).send({ error: "boom" }));
        s.get("/missing", async (_req, reply) => reply.code(404).send({ error: "nf" }));
        s.get("/slow", { config: { kbRequestKind: "polling" } }, async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, SLOW_REQUEST_THRESHOLD_MS + 100);
          });
          return { ok: true };
        });
      },
    });
    servers.push(server);
    return server;
  }

  const completed = (records: Recorded[], level: string) =>
    records.filter((r) => r.message === "HTTP request completed" && r.level === level);

  it("a burst of health probes and polling reads produces no info completion line", async () => {
    const records: Recorded[] = [];
    const server = await make(records);
    await Promise.all(
      Array.from({ length: 100 }, () => server.inject("/probe")),
    );
    await Promise.all(Array.from({ length: 100 }, () => server.inject("/poll")));
    await server.inject("/health");
    expect(completed(records, "info")).toHaveLength(0);
    expect(completed(records, "debug")).toHaveLength(201);
  });

  it("a completed business request is one info line (ADR 0036)", async () => {
    const records: Recorded[] = [];
    const server = await make(records);
    await server.inject("/business");
    const lines = completed(records, "info");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({
      "http.status_code": 200,
      "http.request_kind": "business",
    });
  });

  it("a 500 on a probe route is logged, at warn", async () => {
    const records: Recorded[] = [];
    const server = await make(records);
    await server.inject("/probe-boom");
    expect(completed(records, "debug")).toHaveLength(0);
    const lines = completed(records, "warn");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({
      "http.status_code": 500,
      "http.request_kind": "probe",
    });
  });

  it("a 500 on a business route is warn and a 404 is info", async () => {
    const records: Recorded[] = [];
    const server = await make(records);
    await server.inject("/boom");
    await server.inject("/missing");
    expect(completed(records, "warn")).toHaveLength(1);
    expect(completed(records, "info")).toHaveLength(1);
  });

  it("a slow polling request is logged at info", async () => {
    const records: Recorded[] = [];
    const server = await make(records);
    await server.inject("/slow");
    const lines = completed(records, "info");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields?.["http.status_code"]).toBe(200);
  });
});
