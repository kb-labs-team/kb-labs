/**
 * `/api/v1/health` + `/api/v1/update` host routes: exercised against a fake
 * control-channel server (a real launcher's `control.json` + a small HTTP
 * server standing in for `kb-create supervise`), never against the real
 * launcher — that contract is `launcher-control-client.test.ts`.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHealthRoutes } from "../health-routes.js";

interface ErrorBody {
  ok: false;
  error: { code: string; message: string; hint: string };
}

interface DataBody<T> {
  ok: true;
  data: T;
}

const TOKEN = "test-token-0123456789abcdef";

describe("createHealthRoutes", () => {
  let kbHome: string;
  let app: FastifyInstance | undefined;
  let controlServer: Server | undefined;

  beforeEach(async () => {
    kbHome = await mkdtemp(join(tmpdir(), "kb-host-health-"));
    await mkdir(join(kbHome, "launcher"), { recursive: true });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await new Promise<void>((resolve) => {
      if (controlServer) {
        controlServer.close(() => resolve());
      } else {
        resolve();
      }
    });
    controlServer = undefined;
    await rm(kbHome, { recursive: true, force: true });
  });

  async function writeControlFile(address: string): Promise<void> {
    await writeFile(
      join(kbHome, "launcher", "control.json"),
      JSON.stringify({ protocol: 1, address, token: TOKEN, pid: process.pid, version: "9.9.9-test" }),
    );
  }

  /** A minimal stand-in for the launcher's control channel. */
  async function startControlServer(
    handler: (method: string, path: string, body: unknown) => { status: number; body: unknown },
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const instance = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = raw.length > 0 ? JSON.parse(raw) : undefined;
          const { status, body: responseBody } = handler(req.method ?? "GET", req.url ?? "", body);
          res.setHeader("Content-Type", "application/json");
          res.writeHead(status);
          res.end(JSON.stringify(responseBody));
        });
      });
      instance.on("error", reject);
      instance.listen(0, "127.0.0.1", () => {
        controlServer = instance;
        const address = instance.address();
        if (address === null || typeof address === "string") {
          reject(new Error("expected a TCP address"));
          return;
        }
        resolve(`127.0.0.1:${address.port}`);
      });
    });
  }

  async function setup() {
    app = Fastify();
    await app.register(createHealthRoutes({ controlClient: { env: { KB_HOME: kbHome } } }));
    await app.ready();
    return app;
  }

  it("GET /api/v1/health returns the doctor report from the control channel", async () => {
    const doctorReport = {
      ok: true,
      protocol: 1,
      installation: { ok: true, checks: [{ id: "receipt", ok: true, detail: "platform 2.120.1" }] },
      platform: { ok: true, checks: [{ id: "host-process", ok: true, detail: "pid 4242" }] },
    };
    const address = await startControlServer((_method, path) => {
      expect(path).toBe("/v1/doctor");
      return { status: 200, body: doctorReport };
    });
    await writeControlFile(address);
    const instance = await setup();

    const res = await instance.inject({ method: "GET", url: "/api/v1/health" });

    expect(res.statusCode).toBe(200);
    expect((res.json() as DataBody<typeof doctorReport>).data).toEqual(doctorReport);
  });

  it("GET /api/v1/health reports KB_HOST_CONTROL_UNAVAILABLE when no launcher is running", async () => {
    // No control.json written: connectLauncherControl fails immediately.
    const instance = await setup();

    const res = await instance.inject({ method: "GET", url: "/api/v1/health" });

    expect(res.statusCode).toBe(503);
    expect((res.json() as ErrorBody).error.code).toBe("KB_HOST_CONTROL_UNAVAILABLE");
  });

  it("POST /api/v1/update with a channel queues the request and returns 202", async () => {
    const record = { id: "upd_1", status: "pending", channel: "stable", createdAt: "2026-01-01T00:00:00.000Z" };
    const address = await startControlServer((method, path, body) => {
      expect(method).toBe("POST");
      expect(path).toBe("/v1/update-request");
      expect(body).toEqual({ channel: "stable" });
      return { status: 202, body: { ok: true, protocol: 1, request: record } };
    });
    await writeControlFile(address);
    const instance = await setup();

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/update",
      payload: { channel: "stable" },
    });

    expect(res.statusCode).toBe(202);
    expect((res.json() as DataBody<typeof record>).data).toEqual(record);
  });

  it("POST /api/v1/update rejects both version and channel with KB_RUNTIME_INPUT_INVALID", async () => {
    const instance = await setup();

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/update",
      payload: { version: "1.0.0", channel: "stable" },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as ErrorBody).error.code).toBe("KB_RUNTIME_INPUT_INVALID");
  });

  it("POST /api/v1/update rejects neither version nor channel with KB_RUNTIME_INPUT_INVALID", async () => {
    const instance = await setup();

    const res = await instance.inject({ method: "POST", url: "/api/v1/update", payload: {} });

    expect(res.statusCode).toBe(400);
    expect((res.json() as ErrorBody).error.code).toBe("KB_RUNTIME_INPUT_INVALID");
  });

  it("POST /api/v1/update rejects an unknown channel with KB_RUNTIME_INPUT_INVALID", async () => {
    const instance = await setup();

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/update",
      payload: { channel: "nightly" },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as ErrorBody).error.code).toBe("KB_RUNTIME_INPUT_INVALID");
  });

  it("POST /api/v1/update with an exact version queues the request", async () => {
    const record = { id: "upd_2", status: "pending", version: "1.4.0", createdAt: "2026-01-01T00:00:00.000Z" };
    const address = await startControlServer((_method, _path, body) => {
      expect(body).toEqual({ version: "1.4.0" });
      return { status: 202, body: { ok: true, protocol: 1, request: record } };
    });
    await writeControlFile(address);
    const instance = await setup();

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/update",
      payload: { version: "1.4.0" },
    });

    expect(res.statusCode).toBe(202);
    expect((res.json() as DataBody<typeof record>).data).toEqual(record);
  });

  it("POST /api/v1/update surfaces a rate-limit envelope from the launcher as 429", async () => {
    const address = await startControlServer(() => ({
      status: 429,
      body: {
        ok: false,
        error: {
          code: "KB_RUNTIME_RATE_LIMITED",
          area: "runtime",
          stage: "run",
          severity: "error",
          retryable: true,
          message: "Too many update requests are waiting.",
          hint: "Wait for the pending update requests to be processed.",
        },
      },
    }));
    await writeControlFile(address);
    const instance = await setup();

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/update",
      payload: { channel: "stable" },
    });

    expect(res.statusCode).toBe(429);
    expect((res.json() as ErrorBody).error.code).toBe("KB_RUNTIME_RATE_LIMITED");
  });
});
