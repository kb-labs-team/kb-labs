import * as marketplaceApp from "@kb-labs/marketplace-app";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPlatformResolveHook } from "@kb-labs/plugin-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canBind,
  isPortListening,
  startTestHost,
  type RunningHost,
} from "./harness.js";
import { readUxSuccessResult } from "./testkit.js";

vi.mock("@kb-labs/marketplace-app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kb-labs/marketplace-app")>();
  return { ...actual, setup: vi.fn(actual.setup) };
});

interface HealthBody {
  upstreams: Record<string, { status: string }>;
}

function portOf(url: string | undefined): number {
  if (!url) {throw new Error("missing internal url");}
  return Number(new URL(url).port);
}

describe("kb-host (one process, real launchPlatform, in-memory adapters)", () => {
  let running: RunningHost | undefined;

  afterEach(async () => {
    // stop() is idempotent, so a test that already stopped the host is fine.
    const subject = running;
    running = undefined;
    await subject?.stop();
  });

  // case: PC-002.1
  it("serves the gateway on the configured port and proxies marketplace and state", async () => {
    const studioDir = await mkdtemp(join(tmpdir(), "kb-studio-fixture-"));
    await writeFile(join(studioDir, "index.html"), "<!doctype html><html><head></head><body>fixture</body></html>");
    try {
      running = await startTestHost({ gateway: { studio: { enabled: true, dir: studioDir } } });

      const studio = await running.fetchGateway("/");
      expect(studio.status).toBe(200);
      expect(await studio.text()).toContain("__KB_STUDIO_CONFIG__");

      const health = await running.fetchGateway("/health");
      expect(health.status).toBe(200);
      const body = await readUxSuccessResult<HealthBody>(health);
      expect(body.upstreams.marketplace?.status).toBe("up");
      expect(body.upstreams.state?.status).toBe("up");

      const marketplace = await running.fetchGateway(
        "/api/v1/marketplace/packages",
      );
      expect(marketplace.status).toBe(200);

      const put = await running.fetchGateway("/api/v1/state/state/greeting", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "hello" }),
      });
      expect(put.status).toBe(204);
      const get = await running.fetchGateway("/api/v1/state/state/greeting");
      expect(get.status).toBe(200);
      expect(JSON.parse(await get.text())).toBe("hello");

      const journal = await readFile(
        join(running.projectRoot, ".kb", "data", "state-broker", "journal.jsonl"),
        "utf8",
      );
      expect(journal).toContain("greeting");
    } finally {
      const subject = running;
      running = undefined;
      try {
        await subject?.stop();
      } finally {
        await rm(studioDir, { recursive: true, force: true });
      }
    }
  });

  it("keeps marketplace and state on distinct internal loopback ports", async () => {
    running = await startTestHost();

    const marketplaceUrl = running.internalUrl("marketplace");
    const stateUrl = running.internalUrl("state-daemon");
    expect(marketplaceUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(stateUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const ports = new Set([
      portOf(marketplaceUrl),
      portOf(stateUrl),
      running.gatewayPort,
    ]);
    expect(ports.size).toBe(3);
    // The internal modules answer directly on loopback, so the map is real.
    const direct = await fetch(`${marketplaceUrl}/health`);
    expect(direct.status).toBe(200);
  });

  it("stops every module on SIGTERM, exits 0 and releases all ports", async () => {
    running = await startTestHost();
    const ports = [
      running.gatewayPort,
      portOf(running.internalUrl("marketplace")),
      portOf(running.internalUrl("state-daemon")),
    ];
    for (const port of ports) {
      expect(await isPortListening(port)).toBe(true);
    }

    const exitCode = await running.stop();

    expect(exitCode).toBe(0);
    for (const port of ports) {
      expect(await isPortListening(port)).toBe(false);
      expect(await canBind(port)).toBe(true);
    }
  });

  it("releases the platform resolve hook before another platform root starts", async () => {
    running = await startTestHost();
    const firstRoot = running.projectRoot;
    expect((await running.fetchGateway("/health")).status).toBe(200);

    await running.stop();
    running = undefined;

    running = await startTestHost();
    expect(running.projectRoot).not.toBe(firstRoot);
    expect((await running.fetchGateway("/health")).status).toBe(200);
  });

  it("releases the resolve hook before a module teardown can hang", async () => {
    let unblockTeardown!: () => void;
    let markTeardownStarted!: () => void;
    const teardownStarted = new Promise<void>((resolve) => {
      markTeardownStarted = resolve;
    });
    const blockedTeardown = new Promise<void>((resolve) => {
      unblockTeardown = resolve;
    });
    const setup = vi.mocked(marketplaceApp.setup).mockImplementationOnce(
      async () => async () => {
        markTeardownStarted();
        await blockedTeardown;
      },
    );

    let firstStop: Promise<number> | undefined;
    try {
      const first = await startTestHost();
      firstStop = first.stop();
      await teardownStarted;
      const nextRootHook = installPlatformResolveHook({ platformRoot: process.cwd() });
      nextRootHook.deregister();
    } finally {
      unblockTeardown();
      await firstStop;
      setup.mockRestore();
    }

    running = await startTestHost();
    expect((await running.fetchGateway("/health")).status).toBe(200);
  });

  it("releases the resolve hook when a module teardown throws", async () => {
    const failingTeardown = vi.fn(async () => {
      throw new Error("injected marketplace teardown failure");
    });
    const setup = vi.mocked(marketplaceApp.setup).mockImplementationOnce(
      async () => failingTeardown,
    );

    const first = await startTestHost();
    running = undefined;
    try {
      await first.stop();
      expect(failingTeardown).toHaveBeenCalledOnce();
    } finally {
      setup.mockRestore();
    }

    running = await startTestHost();
    expect((await running.fetchGateway("/health")).status).toBe(200);
  });

  it("runs only the modules listed in host.modules", async () => {
    running = await startTestHost({ host: { modules: ["gateway", "state"] } });

    const health = await readUxSuccessResult<HealthBody>(await running.fetchGateway("/health"));
    expect(health.upstreams.state?.status).toBe("up");
    expect(health.upstreams.marketplace).toBeUndefined();

    const marketplace = await running.fetchGateway(
      "/api/v1/marketplace/packages",
    );
    expect(marketplace.status).toBe(404);

    // The disabled module never bound its reserved port.
    expect(await isPortListening(portOf(running.internalUrl("marketplace")))).toBe(
      false,
    );
  });

  it("does not open the external port when the gateway is not selected", async () => {
    running = await startTestHost({ host: { modules: ["state"] } });

    expect(await isPortListening(running.gatewayPort)).toBe(false);
    const stateUrl = running.internalUrl("state-daemon");
    expect((await fetch(`${stateUrl}/health`)).status).toBe(200);
  });

  it("rejects unsafe setup and releases the hook before another platform root starts", async () => {
    await expect(startTestHost({
      host: { auth: "off" },
      gateway: { host: "0.0.0.0" },
    })).rejects.toMatchObject({
      envelope: {
        code: "KB_HOST_EXPOSURE_REFUSED",
        hint: expect.any(String),
        details: { bindHost: "0.0.0.0" },
      },
    });

    running = await startTestHost();
    expect((await running.fetchGateway("/health")).status).toBe(200);
  });

  it("rejects a first-module setup failure and releases the hook before another root starts", async () => {
    const failure = new Error("marketplace setup failed");
    const setup = vi.mocked(marketplaceApp.setup).mockRejectedValueOnce(failure);
    try {
      await expect(startTestHost()).rejects.toBe(failure);
    } finally {
      setup.mockRestore();
    }

    running = await startTestHost();
    expect((await running.fetchGateway("/health")).status).toBe(200);
  });

  it("requires login on the gateway when host.auth is on", async () => {
    running = await startTestHost({ host: { auth: "on" } });

    const anonymous = await running.fetchGateway("/api/v1/marketplace/packages");
    expect(anonymous.status).toBe(401);
    // /health stays public.
    expect((await running.fetchGateway("/health")).status).toBe(200);
  });

  it("does not require login when host.auth is off (loopback only)", async () => {
    running = await startTestHost({ host: { auth: "off" } });

    const anonymous = await running.fetchGateway("/api/v1/marketplace/packages");
    expect(anonymous.status).toBe(200);
  });
});
