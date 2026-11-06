/**
 * The host with project routing: real gateway, real `launchPlatform`, real
 * project registry (temp KB_HOME) and real child processes, with the fake
 * runtime script standing in for `kb-project-runtime`.
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectRegistry } from "@kb-labs/core-project-registry";
import type { IProjectRegistry } from "@kb-labs/core-project-registry";
import { getCatalogEntry, renderTemplate } from "@kb-labs/core-platform";
import { startTestHost, type HostFixtureConfig, type RunningHost } from "./harness.js";
import {
  FAKE_RUNTIME_ENTRY,
  isAlive,
  makeProject,
  waitFor,
  readUxSuccessResult,
  type FakeRuntimeReply,
  type TestProject,
} from "./testkit.js";
import type { HostOptions } from "../host.js";
import { createChildProcessLauncher } from "../project-runtime/launcher.js";
import type { RuntimeLauncher, RuntimeProject } from "../project-runtime/manager.js";

interface ErrorBody {
  error: { code: string; message: string; hint: string; cause?: string; stack?: string; details?: Record<string, unknown> };
}

interface HealthBody {
  projectRuntimes: {
    limit: number;
    active: number;
    runtimes: Array<{ projectId: string; state: string; inflight: number; keptRunningSchedules?: number; restarts?: number; pid?: number }>;
  };
}

interface PluginRouteBody {
  ok: boolean;
  data?: { scope?: string };
  error?: { code: string; hint: string };
}

interface AnalyticsEventsBody {
  ok: boolean;
  data?: { events?: unknown[] };
  error?: { code: string; message: string };
}

interface ReadyBody {
  ready: boolean;
  components: Record<string, { ready: boolean; status?: string }>;
}

const PROJECT_RUNTIME_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../project-runtime/app/dist/bin.js",
);

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function csrfCookie(response: Response): string {
  const csrf = cookieHeader(response).split("; ").find((cookie) => cookie.startsWith("kb_csrf="));
  if (!csrf) { throw new Error("Auth route did not set a CSRF cookie"); }
  return decodeURIComponent(csrf.slice("kb_csrf=".length));
}

async function configureInstalledPlatformDataRoot(platformRoot: string, stateDataRoot: string, workspaceRoot: string): Promise<void> {
  await mkdir(join(platformRoot, ".kb", "v2"), { recursive: true });
  await mkdir(stateDataRoot, { recursive: true });
  await writeFile(
    join(platformRoot, ".kb", "v2", "platform-layout.json"),
    await readFile(join(workspaceRoot, "tools/kb-create/v2/contracts/platform-layout.json")),
  );
  await symlink(relative(join(platformRoot, ".kb"), stateDataRoot), join(platformRoot, ".kb", "data"), "dir");
}

async function installWorkspaceAdapters(
  platformRoot: string,
  workspaceRoot: string,
  packageNames: readonly string[],
): Promise<Record<string, unknown>> {
  const installedPackageRoot = join(platformRoot, "node_modules", "@kb-labs");
  await mkdir(installedPackageRoot, { recursive: true });
  for (const packageName of packageNames) {
    const adapterName = packageName.replace("@kb-labs/adapters-", "");
    await symlink(
      join(workspaceRoot, "adapters", adapterName),
      join(installedPackageRoot, packageName.slice("@kb-labs/".length)),
      "dir",
    );
  }
  return Object.fromEntries(packageNames.map(packageName => [packageName, {
    version: "2.120.1",
    integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    resolvedPath: relative(platformRoot, join(platformRoot, "node_modules", packageName)),
    source: "platform",
    enabled: true,
  }]));
}

describe("kb-host project routing", () => {
  let kbHome: string;
  let registry: IProjectRegistry;
  let running: RunningHost | undefined;
  const projects: TestProject[] = [];

  beforeEach(async () => {
    kbHome = await mkdtemp(join(tmpdir(), "kb-home-test-"));
    registry = createProjectRegistry({ root: kbHome });
  });

  afterEach(async () => {
    const subject = running;
    running = undefined;
    try {
      await subject?.stop();
    } finally {
      try {
        await Promise.all(projects.splice(0).map((p) => p.cleanup()));
      } finally {
        await rm(kbHome, { recursive: true, force: true });
      }
    }
  });

  async function registered(
    behavior: Parameters<typeof makeProject>[0] = {},
  ): Promise<TestProject> {
    const project = await makeProject(behavior);
    projects.push(project);
    await registry.add(project.root);
    return project;
  }

  async function host(
    hostSection: Record<string, unknown> = {},
    options: HostOptions["projectRuntime"] = {},
    fixture: Omit<HostFixtureConfig, "host"> = {},
  ): Promise<RunningHost> {
    running = await startTestHost(
      { host: hostSection, ...fixture },
      {
        projectRegistry: registry,
        projectRuntime: { entry: FAKE_RUNTIME_ENTRY, stopTimeoutMs: 1500, ...options },
      },
    );
    return running;
  }

  async function reply(
    subject: RunningHost,
    projectId: string,
    path: string,
    init?: RequestInit,
  ): Promise<FakeRuntimeReply> {
    const response = await subject.fetchGateway(
      `/api/v1/projects/${projectId}${path}`,
      init,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as FakeRuntimeReply;
  }

  it("routes each project id to its own runtime, so the projects are isolated", async () => {
    const a = await registered();
    const b = await registered();
    const subject = await host();

    const fromA = await reply(subject, a.id, "/rest/whoami");
    const fromB = await reply(subject, b.id, "/rest/whoami");
    const fromAAgain = await reply(subject, a.id, "/rest/whoami");

    expect(fromA.projectRoot).toBe(a.root);
    expect(fromA.projectId).toBe(a.id);
    expect(fromB.projectRoot).toBe(b.root);
    expect(fromB.projectId).toBe(b.id);
    expect(fromA.pid).not.toBe(fromB.pid);
    expect(fromAAgain.pid).toBe(fromA.pid);
    // The declared REST rewrite restores its service-local API mount.
    expect(fromA.path).toBe("/rest/api/v1/whoami");
  });

  // case: S-124.13, S-192.1, S-192.2, S-192.3, S-192.4, S-191.2
  it("reloads the registered project runtime when its Commit lock changes", async () => {
    const project = await registered();
    execFileSync("git", ["init", "--quiet"], { cwd: project.root });
    await writeFile(join(project.root, "package.json"), JSON.stringify({
      name: "route-lifecycle-fixture",
      version: "1.0.0",
      private: true,
    }));
    await writeFile(join(project.root, ".kb", "kb.config.jsonc"), JSON.stringify({
      plugins: { commit: { enabled: true } },
    }));
    await writeFile(join(project.root, ".kb", "marketplace.lock"), JSON.stringify({
      schema: "kb.marketplace/3",
      plugins: {},
    }));
    const installedPlatformRoot = join(kbHome, "installed-platform");
    await mkdir(join(installedPlatformRoot, ".kb"), { recursive: true });
    const workspaceRoot = join(process.cwd(), "../../..");
    await configureInstalledPlatformDataRoot(
      installedPlatformRoot,
      join(kbHome, "installed-platform-state", "data"),
      workspaceRoot,
    );
    await mkdir(join(installedPlatformRoot, "node_modules", "@kb-labs"), { recursive: true });
    await symlink(join(workspaceRoot, "sdk/sdk"), join(installedPlatformRoot, "node_modules", "@kb-labs", "sdk"), "dir");
    const installedAdapters = {
      storage: "@kb-labs/adapters-fs",
      cache: "@kb-labs/adapters-state-broker",
      eventBus: "@kb-labs/adapters-eventbus-cache",
      documentDatabase: "@kb-labs/adapters-sqlite",
      kvStore: "@kb-labs/adapters-sqlite/kv",
      logger: "@kb-labs/adapters-pino",
      logRingBuffer: "@kb-labs/adapters-log-ringbuffer",
      logPersistence: "@kb-labs/adapters-log-document",
      analytics: "@kb-labs/adapters-analytics-sqlite",
      embeddings: "@kb-labs/adapters-openai/embeddings",
      serviceTransport: "@kb-labs/adapters-service-transport-http",
    };
    await writeFile(join(installedPlatformRoot, ".kb", "kb.config.json"), JSON.stringify({
      platform: {
        deployment: { topology: "local" },
        adapters: installedAdapters,
        adapterOptions: {
          storage: { baseDir: "storage" },
          documentDatabase: { filename: "database/kb.sqlite" },
          kvStore: { filename: "database/kb.sqlite" },
          analytics: { dbPath: "analytics/analytics.sqlite" },
          serviceTransport: { services: {} },
        },
      },
    }));
    const packages = [...new Set(Object.values(installedAdapters).map((value) => value.split("/").slice(0, 2).join("/")))];
    const lockedAdapters = await installWorkspaceAdapters(installedPlatformRoot, workspaceRoot, packages);
    await writeFile(join(installedPlatformRoot, ".kb", "marketplace.lock"), JSON.stringify({
      schema: "kb.marketplace/3",
      plugins: {},
      adapters: lockedAdapters,
    }));
    const previousKbHome = process.env.KB_HOME;
    process.env.KB_HOME = kbHome;
    try {
      const probe = createChildProcessLauncher({
        entry: PROJECT_RUNTIME_ENTRY,
        stopTimeoutMs: 1500,
      });
      const launcher: RuntimeLauncher = {
        launch: (runtimeProject) => createChildProcessLauncher({
          entry: PROJECT_RUNTIME_ENTRY,
          env: {
            KB_PLATFORM_ROOT: installedPlatformRoot,
            KB_HOME: kbHome,
            KB_MCP_AUTH_MODE: "local",
            KB_GATEWAY_URL: `http://127.0.0.1:${running!.gatewayPort}`,
            KB_STATE_DAEMON_URL: running!.internalUrl("state-daemon"),
          },
          stopTimeoutMs: 1500,
        }).launch(runtimeProject),
        probe: probe.probe,
      };
      running = await startTestHost(
        { host: {} },
        {
          projectRegistry: registry,
          projectRuntime: {
            launcher,
            startTimeoutMs: 10_000,
          },
        },
      );

      const unknownService = await running.fetchGateway(
        `/api/v1/projects/${project.id}/unknown-service/health`,
      );
      expect(unknownService.status).toBe(404);
      expect((await unknownService.json() as PluginRouteBody).error?.code)
        .toBe("KB_PROJECT_SERVICE_NOT_FOUND");
      const healthBeforeKnownService = await running.fetchGateway("/health");
      const healthBeforeBody = await readUxSuccessResult<HealthBody>(healthBeforeKnownService);
      expect(healthBeforeBody.projectRuntimes.runtimes).toEqual([]);

      const response = await running.fetchGateway(
        `/api/v1/projects/${project.id}/rest/health`,
      );
      const body = await response.json();
      if (response.status !== 200) {
        throw new Error(String((body as ErrorBody).error.message) + " | " +
          String((body as ErrorBody).error.hint) + " | " +
          String((body as ErrorBody).error.cause).slice(-900));
      }
      expect(body).toEqual(expect.any(Object));

      // case: S-192.6 — the real REST route table accepts its declared internal
      // base and rejects the former public path with a duplicated API version.
      const leakedRestPrefix = await running.fetchGateway(
        `/api/v1/projects/${project.id}/rest/api/v1/health`,
      );
      expect(leakedRestPrefix.status).toBe(404);
      expect((await leakedRestPrefix.json() as PluginRouteBody).error?.code)
        .toBe("KB_RUNTIME_RESOURCE_NOT_FOUND");

      const analyticsResponse = await running.fetchGateway(
        `/api/v1/projects/${project.id}/rest/analytics/events`,
      );
      const analyticsBody = await analyticsResponse.json() as AnalyticsEventsBody;
      expect(analyticsResponse.status, JSON.stringify(analyticsBody)).toBe(200);
      expect(analyticsBody).toMatchObject({ ok: true, data: { events: expect.any(Array) } });

      const routePath = `/api/v1/projects/${project.id}/rest/plugins/commit/status`;
      const absentBeforeInstall = await running.fetchGateway(routePath);
      expect(absentBeforeInstall.status).toBe(404);
      expect((await absentBeforeInstall.json() as PluginRouteBody).error?.code).toBe("KB_PLUGIN_NOT_INSTALLED");

      const projectLockPath = join(project.root, ".kb", "marketplace.lock");
      const commitLink = relative(project.root, join(workspaceRoot, "plugins/commit"));
      const installedLock = {
        schema: "kb.marketplace/3",
        plugins: {
          "@kb-labs/commit": { source: "local", link: commitLink, enabled: true },
        },
      };
      await writeFile(projectLockPath, JSON.stringify(installedLock));
      const installedRoute = await running.fetchGateway(routePath);
      const installedBody = await installedRoute.json() as PluginRouteBody;
      expect(installedRoute.status, JSON.stringify(installedBody)).toBe(200);
      expect(installedBody).toMatchObject({ ok: true, data: { scope: "root" } });

      // The Commit REST route is live, so this proves S-192.6 against the
      // registered plugin route rather than a generic or missing endpoint.
      const leakedCommitPrefix = await running.fetchGateway(
        `/api/v1/projects/${project.id}/rest/api/v1/plugins/commit/status`,
      );
      expect(leakedCommitPrefix.status).toBe(404);
      expect((await leakedCommitPrefix.json() as PluginRouteBody).error?.code)
        .toBe("KB_RUNTIME_RESOURCE_NOT_FOUND");

      await writeFile(projectLockPath, JSON.stringify({ schema: "kb.marketplace/3", plugins: {} }));
      const removedRoute = await running.fetchGateway(routePath);
      expect(removedRoute.status).toBe(404);
      expect((await removedRoute.json() as PluginRouteBody).error).toMatchObject({
        code: "KB_PLUGIN_NOT_INSTALLED",
        hint: "Run `kb marketplace plugins list` to discover available plugins.",
      });

      await writeFile(projectLockPath, JSON.stringify(installedLock));
      const reinstalledRoute = await running.fetchGateway(routePath);
      const reinstalledBody = await reinstalledRoute.json() as PluginRouteBody;
      expect(reinstalledRoute.status, JSON.stringify(reinstalledBody)).toBe(200);
      expect(reinstalledBody).toMatchObject({ ok: true, data: { scope: "root" } });

      const health = await readUxSuccessResult<HealthBody>(await running.fetchGateway("/health"));
      expect(health.projectRuntimes.runtimes).toContainEqual(
        expect.objectContaining({ projectId: project.id, state: "ready", restarts: 3 }),
      );
    } finally {
      const subject = running;
      running = undefined;
      try {
        await subject?.stop();
      } finally {
        if (previousKbHome === undefined) delete process.env.KB_HOME;
        else process.env.KB_HOME = previousKbHome;
      }
    }
  }, 25_000);

  // case: S-045.6, S-045.7, S-045.8, S-140.7
  it("forwards a real secured user access token to the project MCP runtime", async () => {
    const project = await registered();
    const savedEnv = new Map([
      "GATEWAY_JWT_SECRET", "GATEWAY_INTERNAL_SECRET", "GATEWAY_BOOTSTRAP_ADMIN_EMAIL", "GATEWAY_BOOTSTRAP_ADMIN_PASSWORD",
      "GATEWAY_BOOTSTRAP_TENANT_ID", "KB_HOME",
    ].map((key) => [key, process.env[key]]));
    const email = "admin@example.test";
    const password = "JourneyTestPassw0rd!";
    process.env.GATEWAY_JWT_SECRET = "g71-secured-integration-secret-with-at-least-32-characters";
    process.env.GATEWAY_INTERNAL_SECRET = "g71-internal-channel-secret-for-mcp-runtime";
    process.env.GATEWAY_BOOTSTRAP_ADMIN_EMAIL = email;
    process.env.GATEWAY_BOOTSTRAP_ADMIN_PASSWORD = password;
    process.env.GATEWAY_BOOTSTRAP_TENANT_ID = "tenant-g71";
    process.env.KB_HOME = kbHome;
    let runtimeBaseUrl: string | undefined;
    let runtimeToken: string | undefined;
    try {
      const installedPlatformRoot = join(kbHome, "installed-platform");
      await mkdir(join(installedPlatformRoot, ".kb"), { recursive: true });
      const workspaceRoot = join(process.cwd(), "../../..");
      await configureInstalledPlatformDataRoot(
        installedPlatformRoot,
        join(kbHome, "installed-platform-state", "data"),
        workspaceRoot,
      );
      const installedAdapters = {
        storage: "@kb-labs/adapters-fs",
        cache: "@kb-labs/adapters-state-broker",
        eventBus: "@kb-labs/adapters-eventbus-cache",
        documentDatabase: "@kb-labs/adapters-sqlite",
        kvStore: "@kb-labs/adapters-sqlite/kv",
        logger: "@kb-labs/adapters-pino",
        logRingBuffer: "@kb-labs/adapters-log-ringbuffer",
        logPersistence: "@kb-labs/adapters-log-document",
        analytics: "@kb-labs/adapters-analytics-sqlite",
        embeddings: "@kb-labs/adapters-openai/embeddings",
        serviceTransport: "@kb-labs/adapters-service-transport-http",
      };
      await writeFile(join(installedPlatformRoot, ".kb", "kb.config.json"), JSON.stringify({
        platform: {
          deployment: { topology: "local" },
          adapters: installedAdapters,
          adapterOptions: {
            storage: { baseDir: "storage" },
            documentDatabase: { filename: "database/kb.sqlite" },
            kvStore: { filename: "database/kb.sqlite" },
            analytics: { dbPath: "analytics/analytics.sqlite" },
            serviceTransport: { services: {} },
          },
        },
      }));
      const packages = [...new Set(Object.values(installedAdapters).map((value) => value.split("/").slice(0, 2).join("/")))];
      const lockedAdapters = await installWorkspaceAdapters(installedPlatformRoot, workspaceRoot, packages);
      await writeFile(join(installedPlatformRoot, ".kb", "marketplace.lock"), JSON.stringify({
        schema: "kb.marketplace/3", plugins: {}, adapters: lockedAdapters,
      }));
      running = await startTestHost({
        host: { auth: "on" },
        gateway: {
          auth: {
            bootstrap: { adminEmail: email, tenantId: "tenant-g71" },
            bcryptCost: 4,
            cookieSecure: false,
            passwordPolicy: { hibpEnabled: false },
          },
        },
      }, {
        projectRegistry: registry,
        projectRuntime: {
          entry: PROJECT_RUNTIME_ENTRY,
          startTimeoutMs: 15_000,
          launcher: {
            launch: async (runtimeProject) => {
              const runtime = await createChildProcessLauncher({
                entry: PROJECT_RUNTIME_ENTRY,
                env: {
                  KB_PLATFORM_ROOT: installedPlatformRoot,
                  KB_MCP_AUTH_MODE: "secured",
                  KB_GATEWAY_URL: `http://127.0.0.1:${running!.gatewayPort}`,
                  KB_STATE_DAEMON_URL: running!.internalUrl("state-daemon"),
                },
                stopTimeoutMs: 1500,
              }).launch(runtimeProject);
              runtimeBaseUrl = `http://${runtime.address.host}:${runtime.address.port}`;
              runtimeToken = runtime.token;
              return runtime;
            },
            probe: createChildProcessLauncher({ entry: PROJECT_RUNTIME_ENTRY }).probe,
          },
        },
      });

      const login = await running.fetchGateway("/auth/login/cli", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      expect(login.status).toBe(200);
      const session = await readUxSuccessResult<{ accessToken: string }>(login);
      expect(session.accessToken).toBeTruthy();
      const profile = await running.fetchGateway("/auth/me", {
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      expect(profile.status).toBe(200);

      const machineRegistration = await running.fetchGateway("/auth/register", {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "mcp-machine", capabilities: [] }),
      });
      expect(machineRegistration.status).toBe(200);
      const machineCredentials = await readUxSuccessResult<{ clientId: string; clientSecret: string }>(machineRegistration);
      const machineLogin = await running.fetchGateway("/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: machineCredentials.clientId, clientSecret: machineCredentials.clientSecret }),
      });
      expect(machineLogin.status).toBe(200);
      const machineTokens = await readUxSuccessResult<{ accessToken: string }>(machineLogin);
      const machineMcp = await running.fetchGateway(`/api/v1/projects/${project.id}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${machineTokens.accessToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
      });
      expect(machineMcp.status).toBe(200);
      expect(await machineMcp.text()).toContain("kb-labs__mcp_diagnostics");

      const mcpResponse = await running.fetchGateway(`/api/v1/projects/${project.id}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(mcpResponse.status).toBe(200);
      const text = await mcpResponse.text();
      const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      expect(data).toBeTruthy();
      expect(JSON.parse(data!).result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "kb-labs__mcp_diagnostics" }),
      ]));

      if (!runtimeBaseUrl || !runtimeToken) { throw new Error("Project runtime did not expose its internal address"); }
      for (const internalSecret of [undefined, "forged-internal-secret"]) {
        const forged = await fetch(`${runtimeBaseUrl}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-kb-runtime-token": runtimeToken,
            "x-kb-auth-type": "user",
            "x-kb-auth-user-id": "forged-admin",
            "x-kb-auth-namespace-id": "tenant-g71",
            "x-kb-auth-tier": "enterprise",
            "x-kb-auth-permissions": '["users:write"]',
            ...(internalSecret ? { "x-internal-secret": internalSecret } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
        });
        expect(forged.status).toBe(401);
        const forgedBody = await forged.json() as { error: { code: string } };
        expect(forgedBody.error.code).toBe("KB_AUTH_REQUIRED");
      }

      const adminBrowserLogin = await running.fetchGateway("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      expect(adminBrowserLogin.status).toBe(200);
      const adminCookie = cookieHeader(adminBrowserLogin);
      const invite = await running.fetchGateway("/auth/invites", {
        method: "POST",
        headers: { cookie: adminCookie, "x-csrf-token": csrfCookie(adminBrowserLogin), "content-type": "application/json" },
        body: JSON.stringify({ email: "member@example.test", role: "member" }),
      });
      expect(invite.status).toBe(201);
      const inviteBody = await readUxSuccessResult<{ activationUrl: string }>(invite);
      const activationToken = decodeURIComponent(new URL(inviteBody.activationUrl).pathname.split("/").at(-1)!);
      const activation = await running.fetchGateway("/auth/activate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: activationToken, password: "MemberPassw0rd!" }),
      });
      expect(activation.status).toBe(200);
      const memberCookie = cookieHeader(activation);
      const memberProfile = await running.fetchGateway("/auth/me", { headers: { cookie: memberCookie } });
      expect(memberProfile.status).toBe(200);
      const memberId = (await readUxSuccessResult<{ userId: string }>(memberProfile)).userId;
      const memberMcp = await running.fetchGateway(`/api/v1/projects/${project.id}/mcp`, {
        method: "POST",
        headers: { cookie: memberCookie, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }),
      });
      expect(memberMcp.status).toBe(200);
      expect(await memberMcp.text()).toContain("kb-labs__mcp_diagnostics");
      const disabled = await running.fetchGateway(`/auth/users/${memberId}/disable`, {
        method: "POST",
        headers: { cookie: adminCookie, "x-csrf-token": csrfCookie(adminBrowserLogin) },
      });
      expect(disabled.status).toBe(200);
      const disabledMcp = await running.fetchGateway(`/api/v1/projects/${project.id}/mcp`, {
        method: "POST",
        headers: { cookie: memberCookie, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} }),
      });
      expect(disabledMcp.status).toBe(401);
      expect((await disabledMcp.json() as ErrorBody).error.code).toBe("KB_AUTH_USER_INACTIVE");

      const revokeLogin = await running.fetchGateway("/auth/login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      expect(revokeLogin.status).toBe(200);
      const revokeCookie = cookieHeader(revokeLogin);
      const sessions = await running.fetchGateway("/auth/sessions", { headers: { cookie: revokeCookie } });
      expect(sessions.status).toBe(200);
      const sessionFamily = (await readUxSuccessResult<{ sessions: Array<{ familyId: string; isCurrent: boolean }> }>(sessions))
        .sessions.find((session) => session.isCurrent);
      if (!sessionFamily) { throw new Error("Authenticated session family was not listed"); }
      const revoke = await running.fetchGateway(`/auth/sessions/${sessionFamily.familyId}/revoke`, {
        method: "POST", headers: { cookie: revokeCookie, "x-csrf-token": csrfCookie(revokeLogin) },
      });
      expect(revoke.status).toBe(200);
      const revokedMcp = await running.fetchGateway(`/api/v1/projects/${project.id}/mcp`, {
        method: "POST",
        headers: { cookie: revokeCookie, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
      });
      expect(revokedMcp.status).toBe(401);
      expect((await revokedMcp.json() as ErrorBody).error.code).toBe("KB_AUTH_SESSION_REVOKED");

      for (const token of [undefined, "invalid-token"]) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (token !== undefined) headers.authorization = `Bearer ${token}`;
        const denied = await running.fetchGateway(`/api/v1/projects/${project.id}/mcp`, {
          method: "POST", headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        });
        expect(denied.status).toBe(401);
        const deniedBody = await denied.json() as { error: { code: string } };
        expect(deniedBody.error.code).toBe("KB_AUTH_REQUIRED");
      }
    } finally {
      const subject = running;
      running = undefined;
      try {
        await subject?.stop();
      } finally {
        for (const [key, value] of savedEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  });

  // case: S-124.12
  it("keeps valid projects available when the registry contains an identity mismatch", async () => {
    const valid = await registered();
    const corrupt = await registered();
    const contents = JSON.parse(await readFile(registry.filePath, "utf8")) as {
      projects: Array<{ id: string; path: string; name: string; status: string }>;
    };
    const corruptRecord = contents.projects.find((record) => record.id === corrupt.id);
    if (!corruptRecord) {
      throw new Error("corrupt project fixture was not persisted");
    }
    corruptRecord.id = "prj_0000000000000000";
    await writeFile(registry.filePath, JSON.stringify(contents));

    const subject = await host();
    const projectsResponse = await subject.fetchGateway("/api/v1/projects");
    expect(projectsResponse.status).toBe(200);
    const projectsBody = await projectsResponse.json() as { data: Array<{ id: string }> };
    expect(projectsBody.data.map((project) => project.id)).toContain(valid.id);
    expect(projectsBody.data.map((project) => project.id)).not.toContain(corruptRecord.id);

    const validReply = await reply(subject, valid.id, "/rest/whoami");
    expect(validReply.projectId).toBe(valid.id);

    const corruptResponse = await subject.fetchGateway(
      `/api/v1/projects/${corruptRecord.id}/rest/whoami`,
    );
    expect(corruptResponse.status).toBe(500);
    const corruptBody = await corruptResponse.json() as ErrorBody;
    expect(corruptBody.error.code).toBe("KB_PROJECT_REGISTRY_CORRUPT");
    const catalogEntry = getCatalogEntry("KB_PROJECT_REGISTRY_CORRUPT");
    const errorDetails = corruptBody.error.details ?? {};
    expect(corruptBody.error.message).toBe(renderTemplate(
      catalogEntry.message,
      Object.fromEntries(Object.entries(errorDetails).map(([key, value]) => [key, String(value)])),
      ["file", "reason"],
    ));
    expect(corruptBody.error.hint).toBe(renderTemplate(
      catalogEntry.hint,
      Object.fromEntries(Object.entries(errorDetails).map(([key, value]) => [key, String(value)])),
      ["file"],
    ));
    expect(corruptBody.error.cause).toBeUndefined();
    expect(corruptBody.error.stack).toBeUndefined();
    expect(JSON.stringify(corruptBody)).not.toContain("Error:");
    expect(JSON.stringify(corruptBody)).not.toContain(" at ");
  });

  // case: S-226.2
  it("returns the runtime's typed project identity mismatch without exposing a stack", async () => {
    const project = await registered();
    const launcher: RuntimeLauncher = {
      async launch(_runtimeProject: RuntimeProject) {
        return {
          pid: undefined,
          address: { host: "127.0.0.1", port: 1 },
          token: "test-runtime-token",
          exited: Promise.resolve({ code: 1, signal: null }),
          stop: async () => undefined,
          outputTail: () => "KB_PROJECT_RUNTIME_IDENTITY_MISMATCH: registry path mismatch",
        };
      },
      probe: async () => false,
    };
    const subject = await host({}, { launcher });

    const response = await subject.fetchGateway(
      `/api/v1/projects/${project.id}/rest/health`,
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe("KB_PROJECT_RUNTIME_IDENTITY_MISMATCH");
    expect(body.error.hint).toContain("kb project list");
    expect(JSON.stringify(body)).not.toContain("Error:");
    expect(JSON.stringify(body)).not.toContain("at ");
  });

  it("forwards method, query and body, and sets the runtime headers itself", async () => {
    const a = await registered();
    const subject = await host();

    const echoed = await reply(subject, a.id, "/rest/items?limit=5&sort=asc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer caller-token",
        // A client must not be able to speak to the runtime as the host.
        "x-kb-runtime-token": "forged",
        "x-kb-project-id": "prj_forged",
      },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(echoed.method).toBe("POST");
    expect(echoed.search).toBe("?limit=5&sort=asc");
    expect(JSON.parse(echoed.body)).toEqual({ hello: "world" });
    expect(echoed.received.authorization).toBe("Bearer caller-token");
    expect(echoed.received.projectHeader).toBe(a.id);
    expect(echoed.received.tokenHeader).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps runtime addresses and secrets out of the public health payload", async () => {
    const a = await registered();
    const subject = await host();
    await reply(subject, a.id, "/rest/whoami");
    const runtime = await readUxSuccessResult<HealthBody>(await subject.fetchGateway("/health"));
    expect(runtime.projectRuntimes.runtimes).toHaveLength(1);
    // Nothing in the public health payload reveals the runtime's address.
    expect(JSON.stringify(runtime)).not.toMatch(/127\.0\.0\.1:\d+/);
    expect(JSON.stringify(runtime)).not.toContain("port");
  });

  // case: S-010.7
  it("passes live host service addresses into the child runtime", async () => {
    const a = await registered();
    const subject = await host();
    expect(process.env.KB_STATE_DAEMON_URL).toBeUndefined();
    const { stateDaemonUrl: stateUrl, gatewayUrl, firstLeaseStatus } = await reply(subject, a.id, "/rest/__host-services");

    if (typeof stateUrl !== "string" || typeof gatewayUrl !== "string" || typeof firstLeaseStatus !== "number") {
      throw new Error("project runtime did not receive usable host service addresses");
    }
    expect(stateUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(stateUrl).not.toBe("http://127.0.0.1:7777");
    expect(gatewayUrl).toBe(`http://127.0.0.1:${subject.gatewayPort}`);
    expect(firstLeaseStatus).toBe(404);
  });

  // case: S-203.15
  it("uses the default gateway listener address when gateway.port is absent", async () => {
    const project = await registered();
    const subject = await host({}, {}, { defaultGatewayPort: true });
    const platformConfig = JSON.parse(
      await readFile(`${subject.projectRoot}/.kb/kb.config.json`, "utf8"),
    ) as { gateway?: Record<string, unknown> };
    expect(platformConfig.gateway).not.toHaveProperty("port");

    const runtime = await reply(subject, project.id, "/rest/__host-services");
    expect(runtime.gatewayUrl).toBe(`http://127.0.0.1:${subject.gatewayPort}`);
  });

  it("answers KB_PROJECT_UNKNOWN for an id that is not in the registry, without starting anything", async () => {
    const subject = await host();

    const response = await subject.fetchGateway(
      "/api/v1/projects/prj_0000000000000000/rest/whoami",
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe("KB_PROJECT_UNKNOWN");
    expect(body.error.hint.length).toBeGreaterThan(0);
    const health = await readUxSuccessResult<HealthBody>(await subject.fetchGateway("/health"));
    expect(health.projectRuntimes.runtimes).toEqual([]);
  });

  it("addresses projects by id only, not by registered name or path", async () => {
    const a = await registered();
    const subject = await host();
    const view = await registry.get(a.id);

    for (const ref of [view.project.name, encodeURIComponent(a.root)]) {
      const response = await subject.fetchGateway(
        `/api/v1/projects/${ref}/rest/whoami`,
      );
      expect(response.status).toBe(404);
      expect(((await response.json()) as ErrorBody).error.code).toBe(
        "KB_PROJECT_UNKNOWN",
      );
    }
  });

  it("answers KB_PROJECT_RUNTIME_START_FAILED when the runtime does not start", async () => {
    const a = await registered({ exitBeforeReady: 4 });
    const subject = await host();

    const response = await subject.fetchGateway(
      `/api/v1/projects/${a.id}/rest/whoami`,
    );

    expect(response.status).toBe(502);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe("KB_PROJECT_RUNTIME_PROCESS_START_FAILED");
    expect(body.error.details).toEqual({ projectId: a.id });
    // Other projects are unaffected.
    const b = await registered();
    expect((await reply(subject, b.id, "/rest/whoami")).projectRoot).toBe(b.root);
  });

  it("answers KB_PROJECT_RUNTIME_LIMIT when every runtime slot is busy", async () => {
    const a = await registered();
    const b = await registered();
    const subject = await host({ maxActiveProjects: 1 });
    await reply(subject, a.id, "/rest/whoami");

    // A request that stays in flight keeps A's runtime busy.
    const slow = subject.fetchGateway(
      `/api/v1/projects/${a.id}/rest/slow?delay=1500`,
    );
    await waitFor(async () => {
      const health = await readUxSuccessResult<HealthBody>(await subject.fetchGateway("/health"));
      return health.projectRuntimes.runtimes[0]?.inflight === 1;
    }, "the slow request to be in flight");

    const response = await subject.fetchGateway(
      `/api/v1/projects/${b.id}/rest/whoami`,
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as ErrorBody).error.code).toBe(
      "KB_PROJECT_RUNTIME_LIMIT");

    expect((await slow).status).toBe(200);
    // Once A is idle, B gets the slot.
    await waitFor(async () => {
      const retry = await subject.fetchGateway(
        `/api/v1/projects/${b.id}/rest/whoami`,
      );
      return retry.status === 200;
    }, "B to start once A is idle");
  });

  it("applies the gateway's authentication before a project runtime is ever started", async () => {
    const a = await registered();
    const subject = await host({ auth: "on" });

    const response = await subject.fetchGateway(
      `/api/v1/projects/${a.id}/rest/whoami`,
    );

    expect(response.status).toBe(401);
    // Public /health still answers, and nothing was started for the anonymous call.
    const health = await readUxSuccessResult<HealthBody>(await subject.fetchGateway("/health"));
    expect(health.projectRuntimes.runtimes).toEqual([]);
  });

  it("is ready and healthy with no project runtime, and reflects runtimes once they start lazily", async () => {
    const a = await registered();
    const subject = await host({ maxActiveProjects: 3 });

    const before = await subject.fetchGateway("/ready");
    expect(before.status).toBe(200);
    const beforeBody = await readUxSuccessResult<ReadyBody>(before);
    expect(beforeBody.ready).toBe(true);
    expect(beforeBody.components.projectRuntimes).toEqual({
      ready: true,
      status: "0/3 active",
    });

    await reply(subject, a.id, "/rest/whoami");

    const health = await readUxSuccessResult<HealthBody>(await subject.fetchGateway("/health"));
    expect(health.projectRuntimes.limit).toBe(3);
    expect(health.projectRuntimes.active).toBe(1);
    expect(health.projectRuntimes.runtimes).toEqual([
      expect.objectContaining({ projectId: a.id, state: "ready", inflight: 0 }),
    ]);
    const after = await readUxSuccessResult<ReadyBody>(await subject.fetchGateway("/ready"));
    expect(after.components.projectRuntimes?.status).toBe("1/3 active");
  });

  it("stops an idle runtime through the host", async () => {
    const a = await registered();
    const subject = await host({}, { idleTimeoutMs: 300, sweepIntervalMs: 50 });
    const { pid } = await reply(subject, a.id, "/rest/whoami");
    expect(isAlive(pid)).toBe(true);

    await waitFor(() => !isAlive(pid), "the idle runtime to stop");
    await waitFor(async () => {
      const response = await subject.fetchGateway("/health");
      const health = await readUxSuccessResult<HealthBody>(response);
      return health.projectRuntimes.runtimes.length === 0;
    }, "the stopped runtime to leave the health registry");

    await waitFor(async () => {
      const health = await readUxSuccessResult<HealthBody>(await subject.fetchGateway("/health"));
      return health.projectRuntimes.runtimes.length === 0;
    }, "the stopped idle runtime to disappear from health");
    const health = await readUxSuccessResult<HealthBody>(await subject.fetchGateway("/health"));
    expect(health.projectRuntimes.runtimes).toEqual([]);
    // The next request starts it again.
    const again = await reply(subject, a.id, "/rest/whoami");
    expect(again.pid).not.toBe(pid);
  });

  it("starts scheduled workflow projects at host boot and keeps them warm", async () => {
    const a = await registered();
    const crons = join(a.root, ".kb", "crons");
    await mkdir(crons, { recursive: true });
    await writeFile(join(crons, "every-minute.yml"), [
      'schedule: "* * * * *"',
      "workflow: scheduled",
      "",
    ].join("\n"));
    await writeFile(join(crons, "hourly.yml"), [
      'schedule: "0 * * * *"',
      "timezone: UTC",
      "enabled: true",
      "workflow: stored-active",
      "",
    ].join("\n"));
    await writeFile(join(crons, "paused.yml"), [
      'schedule: "30 * * * *"',
      "enabled: false",
      "workflow: stored-paused",
      "",
    ].join("\n"));
    const subject = await host({}, { idleTimeoutMs: 30, sweepIntervalMs: 10, startPollMs: 10 });

    await waitFor(async () => {
      const health = await readUxSuccessResult<HealthBody>(await subject.fetchGateway("/health"));
      return health.projectRuntimes.runtimes.some(
        (runtime) => runtime.projectId === a.id && runtime.state === "ready",
      );
    }, "the scheduled runtime to start during host startup");

    const before = await readUxSuccessResult<HealthBody>(await subject.fetchGateway("/health"));
    expect(before.projectRuntimes.runtimes[0]).toMatchObject({
      projectId: a.id,
      keptRunningSchedules: 2,
    });
    const pid = (await reply(subject, a.id, "/rest/whoami")).pid;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 120);
    });
    expect(isAlive(pid)).toBe(true);
  });

  it("stops every project runtime when the host shuts down, leaving no orphans", async () => {
    const a = await registered();
    const b = await registered();
    const subject = await host();
    const pids = [
      (await reply(subject, a.id, "/rest/whoami")).pid,
      (await reply(subject, b.id, "/rest/whoami")).pid,
    ];
    const { childPid } = (await (
      await subject.fetchGateway(`/api/v1/projects/${a.id}/rest/__spawn-child`)
    ).json()) as { childPid: number };
    for (const pid of [...pids, childPid]) {
      expect(isAlive(pid)).toBe(true);
    }

    const exitCode = await subject.stop();

    expect(exitCode).toBe(0);
    expect(await readFile(join(a.root, "runtime-child-stopped"), "utf8")).toBe("stopped");
  });

  it("records the use of a project in the registry when its runtime starts", async () => {
    const a = await registered();
    const subject = await host();
    expect((await registry.get(a.id)).project.lastUsedAt).toBeNull();

    await reply(subject, a.id, "/rest/whoami");

    await waitFor(
      async () => (await registry.get(a.id)).project.lastUsedAt !== null,
      "lastUsedAt to be recorded",
    );
  });
});
