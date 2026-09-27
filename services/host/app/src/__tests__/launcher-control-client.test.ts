/**
 * `LauncherControlClient` (ADR-0045): connects through a temp `KB_HOME`'s
 * `control.json` and talks the same wire protocol as the Go launcher
 * (`tools/kb-create/v2/control`). Several cases replay the shared JSON
 * fixtures (`core/platform/src/launcher-control/fixtures/v1`), mirroring the
 * Go-side contract test (`control_test.go: TestSharedProtocolFixtures`) with
 * matcher placeholders ("$string", "$number", "$iso8601") materialized into
 * concrete values so both the served response and the expectation agree.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectLauncherControl,
  isLauncherControlError,
  type DoctorResponse,
  type StatusResponse,
  type UpdateRequestResponse,
} from "../launcher-control-client.js";

const FIXTURES_DIR = fileURLToPath(
  new URL("../../../../../core/platform/src/launcher-control/fixtures/v1/", import.meta.url),
);

const TOKEN = "test-token-0123456789abcdef";

interface Exchange {
  request: { method: string; path: string; auth: "valid" | "wrong" | "none"; body?: unknown };
  response: { status: number; body: unknown };
}

async function loadFixture(name: string): Promise<Exchange> {
  const raw = await readFile(join(FIXTURES_DIR, `${name}.json`), "utf8");
  return JSON.parse(raw) as Exchange;
}

/** Replaces "$string"/"$number"/"$iso8601" matcher placeholders with concrete values. */
function materialize(value: unknown): unknown {
  if (typeof value === "string") {
    switch (value) {
      case "$string":
        return "sample-value";
      case "$number":
        return 4242;
      case "$iso8601":
        return "2026-01-01T00:00:00.000Z";
      default:
        return value;
    }
  }
  if (Array.isArray(value)) {
    return value.map(materialize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, materialize(v)]));
  }
  return value;
}

describe("LauncherControlClient", () => {
  let kbHome: string;
  let server: Server | undefined;

  beforeEach(async () => {
    kbHome = await mkdtemp(join(tmpdir(), "kb-launcher-control-"));
    await mkdir(join(kbHome, "launcher"), { recursive: true });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
    server = undefined;
    await rm(kbHome, { recursive: true, force: true });
  });

  async function writeControlFile(address: string, token = TOKEN): Promise<void> {
    await writeFile(
      join(kbHome, "launcher", "control.json"),
      JSON.stringify({ protocol: 1, address, token, pid: process.pid, version: "9.9.9-test" }),
      { mode: 0o600 },
    );
  }

  async function startFixtureServer(fixture: Exchange): Promise<string> {
    const materializedResponse = materialize(fixture.response.body);
    return new Promise((resolve, reject) => {
      const instance = createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(fixture.response.status);
        res.end(JSON.stringify(materializedResponse));
      });
      instance.on("error", reject);
      instance.listen(0, "127.0.0.1", () => {
        server = instance;
        const address = instance.address();
        if (address === null || typeof address === "string") {
          reject(new Error("expected a TCP address"));
          return;
        }
        resolve(`127.0.0.1:${address.port}`);
      });
    });
  }

  it("throws KB_HOST_CONTROL_UNAVAILABLE when control.json is missing", async () => {
    await expect(connectLauncherControl({ env: { KB_HOME: kbHome } })).rejects.toMatchObject({
      envelope: { code: "KB_HOST_CONTROL_UNAVAILABLE" },
    });
  });

  it("throws KB_HOST_CONTROL_UNAVAILABLE when the launcher pid is dead", async () => {
    // A pid essentially guaranteed not to be a live process on any platform.
    await writeControlFile("127.0.0.1:1");
    await writeFile(
      join(kbHome, "launcher", "control.json"),
      JSON.stringify({ protocol: 1, address: "127.0.0.1:1", token: TOKEN, pid: 2147483646, version: "9.9.9-test" }),
    );
    await expect(connectLauncherControl({ env: { KB_HOME: kbHome } })).rejects.toMatchObject({
      envelope: { code: "KB_HOST_CONTROL_UNAVAILABLE" },
    });
  });

  it("replays status-ok.json", async () => {
    const fixture = await loadFixture("status-ok");
    const address = await startFixtureServer(fixture);
    await writeControlFile(address);
    const client = await connectLauncherControl({ env: { KB_HOME: kbHome } });

    const status: StatusResponse = await client.status();

    expect(status).toEqual(materialize(fixture.response.body));
  });

  it("replays doctor-ok.json", async () => {
    const fixture = await loadFixture("doctor-ok");
    const address = await startFixtureServer(fixture);
    await writeControlFile(address);
    const client = await connectLauncherControl({ env: { KB_HOME: kbHome } });

    const doctor: DoctorResponse = await client.doctor();

    expect(doctor).toEqual(materialize(fixture.response.body));
    expect(doctor.installation.checks[0]).toMatchObject({ id: "receipt", ok: false });
  });

  it("replays update-request-accepted.json", async () => {
    const fixture = await loadFixture("update-request-accepted");
    const address = await startFixtureServer(fixture);
    await writeControlFile(address);
    const client = await connectLauncherControl({ env: { KB_HOME: kbHome } });

    const accepted: UpdateRequestResponse = await client.requestUpdate({
      channel: "stable",
      requestedBy: "studio",
    });

    expect(accepted).toEqual(materialize(fixture.response.body));
  });

  it("replays update-request-exact-version.json", async () => {
    const fixture = await loadFixture("update-request-exact-version");
    const address = await startFixtureServer(fixture);
    await writeControlFile(address);
    const client = await connectLauncherControl({ env: { KB_HOME: kbHome } });

    const accepted = await client.requestUpdate({ version: "1.4.0-canary.2" });

    expect(accepted).toEqual(materialize(fixture.response.body));
  });

  it("replays update-request-invalid.json as a thrown LauncherControlError", async () => {
    const fixture = await loadFixture("update-request-invalid");
    const address = await startFixtureServer(fixture);
    await writeControlFile(address);
    const client = await connectLauncherControl({ env: { KB_HOME: kbHome } });

    try {
      await client.requestUpdate({ version: "1.0.0", channel: "stable" });
      expect.unreachable("expected requestUpdate to throw");
    } catch (error) {
      expect(isLauncherControlError(error)).toBe(true);
      const expected = materialize(fixture.response.body) as { error: unknown };
      expect(isLauncherControlError(error) && error.envelope).toEqual(expected.error);
    }
  });

  it("replays unauthorized-wrong-token.json when control.json's token is stale", async () => {
    const fixture = await loadFixture("unauthorized-wrong-token");
    const address = await startFixtureServer(fixture);
    // The server in this fixture always answers 401 regardless of the header,
    // so any token demonstrates the client surfaces the envelope unchanged.
    await writeControlFile(address, "a-token-the-server-does-not-recognize");
    const client = await connectLauncherControl({ env: { KB_HOME: kbHome } });

    try {
      await client.status();
      expect.unreachable("expected status to throw");
    } catch (error) {
      expect(isLauncherControlError(error)).toBe(true);
      const expected = materialize(fixture.response.body) as { error: unknown };
      expect(isLauncherControlError(error) && error.envelope).toEqual(expected.error);
    }
  });
});
