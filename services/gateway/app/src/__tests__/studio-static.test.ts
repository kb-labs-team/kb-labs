/**
 * Gateway serves Studio (task 2.3, ADR-0043 B5): static + SPA fallback +
 * runtime config injection + /api alias, against the real `createServer`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ICache, ILogger, IServiceTransport } from "@kb-labs/core-platform";
import type { GatewayConfig } from "@kb-labs/gateway-contracts";
import { createServer } from "../server.js";
import {
  StudioAssetsMissingError,
  createStudioStatic,
  createStudioUrlRewriter,
  resolveStudioDir,
} from "../studio/static.js";

function makeCache(): ICache {
  const store = new Map<string, unknown>();
  return {
    async get<T>(k: string) {
      return (store.get(k) as T) ?? null;
    },
    async set(k: string, v: unknown) {
      store.set(k, v);
    },
    async delete(k: string) {
      store.delete(k);
    },
    async clear() {
      store.clear();
    },
  } as unknown as ICache;
}

function makeLogger(): ILogger {
  const noop = () => undefined;
  const logger: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  };
  logger.child = () => logger;
  return logger as unknown as ILogger;
}

const transport = {
  connectionInfo: () => undefined,
  call: async () => ({ ok: true, statusCode: 200, payload: null }),
  stream: async () => {
    throw new Error("not used");
  },
} as unknown as IServiceTransport;

const jwtConfig = { secret: "test-secret-at-least-32-chars-long!" };

function baseConfig(studio?: GatewayConfig["studio"]): GatewayConfig {
  return {
    port: 0,
    upstreams: {},
    staticTokens: {},
    ...(studio ? { studio } : {}),
  };
}

function build(config: GatewayConfig): Promise<FastifyInstance> {
  return createServer(
    config,
    makeCache(),
    makeLogger(),
    jwtConfig,
    undefined,
    transport,
  );
}

let root: string;
let studioDir: string;
const apps: FastifyInstance[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gw-studio-"));
  studioDir = join(root, "dist");
  mkdirSync(join(studioDir, "assets"), { recursive: true });
  writeFileSync(
    join(studioDir, "index.html"),
    "<!doctype html><html><head><title>fake studio</title></head><body>SPA</body></html>",
  );
  writeFileSync(join(studioDir, "assets", "main.abcdef12.js"), "console.log(1)");
  writeFileSync(join(studioDir, "favicon.ico"), "ico");
  writeFileSync(join(root, "secret.txt"), "TOP-SECRET");
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  rmSync(root, { recursive: true, force: true });
});

async function studioApp(
  extra: Partial<NonNullable<GatewayConfig["studio"]>> = {},
): Promise<FastifyInstance> {
  const app = await build(
    baseConfig({ enabled: true, dir: studioDir, ...extra }),
  );
  apps.push(app);
  return app;
}

describe("studio hosting enabled", () => {
  it("serves index.html at / with injected runtime config and no-cache", async () => {
    const app = await studioApp({ eventsBaseUrl: "/events" });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body).toContain(
      '<script>window.__KB_STUDIO_CONFIG__ = {"KB_API_BASE_URL":"/api/v1","KB_EVENTS_BASE_URL":"/events"};</script></head>',
    );
  });

  it("escapes the config so it cannot close the script tag", async () => {
    const app = await studioApp({ apiBaseUrl: "/x</script><b>" });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).not.toContain("</script><b>");
    expect(res.body).toContain("\\u003c/script>");
  });

  it("falls back to index.html for unknown extension-less paths", async () => {
    const app = await studioApp();
    const res = await app.inject({ method: "GET", url: "/projects/abc/settings?x=1" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("__KB_STUDIO_CONFIG__");
  });

  it("serves hashed assets as immutable and plain files as no-cache", async () => {
    const app = await studioApp();
    const js = await app.inject({ method: "GET", url: "/assets/main.abcdef12.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("application/javascript");
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(js.body).toBe("console.log(1)");
    const ico = await app.inject({ method: "GET", url: "/favicon.ico" });
    expect(ico.statusCode).toBe(200);
    expect(ico.headers["cache-control"]).toBe("no-cache");
  });

  it("returns 404 (not index.html) for a missing file with an extension", async () => {
    const app = await studioApp();
    const res = await app.inject({ method: "GET", url: "/assets/missing.js" });
    // Falls through to normal routing (401 while auth is enforced), never the SPA.
    expect(res.statusCode).not.toBe(200);
    expect(res.body).not.toContain("SPA");
  });

  it("does not serve files outside the directory", async () => {
    const app = await studioApp();
    for (const url of ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.body).not.toContain("TOP-SECRET");
    }
  });

  it("does not shadow /health and reserved gateway paths", async () => {
    const app = await studioApp();
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toHaveProperty("status");
    for (const url of ["/api/nope", "/auth/nope", "/hosts/nope", "/webhooks/x/y", "/docs-all"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.body).not.toContain("__KB_STUDIO_CONFIG__");
    }
  });

  it("serves the SPA shell without credentials while auth is enforced", async () => {
    const app = await studioApp();
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.statusCode).toBe(200);
    const guarded = await app.inject({ method: "GET", url: "/hosts" });
    expect(guarded.statusCode).toBe(401);
  });

  it("ignores non-GET methods", async () => {
    const app = await studioApp();
    const res = await app.inject({ method: "POST", url: "/anything", payload: {} });
    expect(res.statusCode).not.toBe(200);
  });

  it("aliases /api/auth/* to the native /auth/* handler", async () => {
    const app = await studioApp();
    const init = {
      method: "POST" as const,
      headers: { "content-type": "application/json" },
      payload: { grant_type: "nope" },
    };
    const native = await app.inject({ ...init, url: "/auth/token" });
    const alias = await app.inject({ ...init, url: "/api/auth/token" });
    expect(native.statusCode).not.toBe(404);
    expect(alias.statusCode).toBe(native.statusCode);
    expect(alias.body).toBe(native.body);
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
  });

  it("serves over a real socket on a random port", async () => {
    const app = await studioApp();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`${address}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("__KB_STUDIO_CONFIG__");
    const health = await fetch(`${address}/health`);
    expect(health.status).toBe(200);
  });
});

describe("studio hosting startup", () => {
  it("fails with KB_HOST_STUDIO_ASSETS_MISSING when the directory is missing", async () => {
    const promise = build(
      baseConfig({ enabled: true, dir: join(root, "does-not-exist") }),
    );
    await expect(promise).rejects.toBeInstanceOf(StudioAssetsMissingError);
    await promise.catch((error: StudioAssetsMissingError) => {
      expect(error.envelope.code).toBe("KB_HOST_STUDIO_ASSETS_MISSING");
      expect(error.envelope.hint.length).toBeGreaterThan(0);
      expect(error.envelope.details?.dir).toContain("does-not-exist");
    });
  });

  it("resolves the @kb-labs/studio-app dist when no dir is configured", () => {
    const dir = resolveStudioDir(
      {},
      () => join(root, "pkg", "package.json"),
    );
    expect(dir).toBe(join(root, "pkg", "dist"));
    expect(resolveStudioDir({ dir: studioDir })).toBe(studioDir);
  });

  it("reports missing assets when the package cannot be resolved", async () => {
    const promise = createStudioStatic(baseConfig({ enabled: true }), () => {
      throw new Error("Cannot find module");
    });
    await expect(promise).rejects.toMatchObject({
      envelope: { code: "KB_HOST_STUDIO_ASSETS_MISSING" },
    });
  });
});

describe("studio URL rewriter", () => {
  it("leaves configured upstream prefixes and unknown /api paths alone", () => {
    const rewrite = createStudioUrlRewriter({
      ...baseConfig(),
      upstreams: { rest: { serviceId: "rest", prefix: "/api/v1" } },
    });
    expect(rewrite("/api/auth/me?x=1")).toBe("/auth/me?x=1");
    expect(rewrite("/api/v1/health")).toBe("/api/v1/health");
    expect(rewrite("/api/other")).toBe("/api/other");
    expect(rewrite("/auth/me")).toBe("/auth/me");
  });
});

describe("studio hosting disabled (default): existing routes untouched", () => {
  it("does not serve Studio and keeps native routes", async () => {
    for (const config of [baseConfig(), baseConfig({ enabled: false, dir: studioDir })]) {
      const app = await build(config);
      apps.push(app);
      expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/projects/x" })).statusCode).not.toBe(200);
      expect((await app.inject({ method: "GET", url: "/favicon.ico" })).statusCode).not.toBe(200);
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect(
        (await app.inject({ method: "POST", url: "/api/auth/token", payload: {} })).statusCode,
      ).toBe(401); // no alias: the auth hook rejects it before any handler
      const token = await app.inject({
        method: "POST",
        url: "/auth/token",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(token.statusCode).not.toBe(404);
    }
  });
});
