import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjectRegistry } from "@kb-labs/core-project-registry";
import type { LoadPlatformConfigResult } from "@kb-labs/core-runtime";

const mocks = vi.hoisted(() => ({
  loadPlatformConfiguration: vi.fn(),
  resolveProjectConfig: vi.fn(),
  initializePlatform: vi.fn(),
}));

vi.mock("../platform-init.js", () => ({
  loadPlatformConfiguration: mocks.loadPlatformConfiguration,
  resolveProjectConfig: mocks.resolveProjectConfig,
  initializePlatform: mocks.initializePlatform,
}));

import { executeCli } from "../bootstrap.js";
import { createPlatformConfigFixture } from './fixtures/platform-config.js';

describe("CLI platform configuration, auth, and adapter ordering", () => {
  let isolatedHome: string | undefined;
  let fixtureCatalogs: LoadPlatformConfigResult['catalog'][] = [];
  const originalEnv = { ...process.env };
  const logger = {
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return logger; },
  };
  const platform = { logger, getAdapter: () => undefined };

  afterEach(async () => {
    await Promise.all(fixtureCatalogs.map((catalog) => catalog.dispose()));
    fixtureCatalogs = [];
    if (isolatedHome) await rm(isolatedHome, { recursive: true, force: true });
    isolatedHome = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    vi.clearAllMocks();
  });

  async function isolateEnvironment(): Promise<string> {
    isolatedHome = await mkdtemp(path.join(os.tmpdir(), "kb-cli-init-order-"));
    process.env.HOME = isolatedHome;
    process.env.KB_HOME = path.join(isolatedHome, ".kb");
    delete process.env.KB_PLATFORM_ROOT;
    delete process.env.KB_PROJECT_ROOT;
    delete process.env.KB_PROJECT_ID;
    delete process.env.KB_NET_OFFSET;
    delete process.env.KB_GATEWAY_URL;
    process.env.KB_LOG_LEVEL = "silent";
    process.env.CLI_VERSION = "2.120.1";
    return isolatedHome;
  }

  async function mockConfig(projectRoot: string, projectScope: 'required' | 'platform' = 'platform', rawConfig = {
    gateway: { access: { mode: "local" } },
    platform: { deployment: { topology: "local" } },
  }, registeredProject = true) {
    const config = await createPlatformConfigFixture({
      cwd: projectRoot,
      home: isolatedHome!,
      rawConfig,
      projectScope,
      registeredProjects: registeredProject ? [projectRoot] : [],
    });
    fixtureCatalogs.push(config.catalog);
    return {
      ...config,
      platformConfig: { adapters: { storage: "@kb-labs/adapters-fs" } },
    };
  }

  function mockInitialization(): void {
    mocks.initializePlatform.mockImplementation(async (config) => ({ ...config, platform }));
  }

  it("loads project config after the gate, then initializes adapters once with the project root", async () => {
    const home = await isolateEnvironment();
    const projectRoot = path.join(home, "registered-project");
    const cwd = projectRoot;
    const platformConfig = await mockConfig(cwd);
    const projectConfig = await mockConfig(projectRoot, 'required');
    mocks.loadPlatformConfiguration.mockResolvedValue(platformConfig);
    mocks.resolveProjectConfig.mockResolvedValue(projectConfig);
    mockInitialization();

    await executeCli(["config", "show", "--help"], {
      cwd,
      registerBuiltinCommands: () => {},
    });

    expect(mocks.loadPlatformConfiguration).toHaveBeenCalledExactlyOnceWith(cwd, undefined, "platform", { persistCatalogSnapshot: false });
    expect(mocks.resolveProjectConfig).toHaveBeenCalledExactlyOnceWith(cwd, undefined);
    expect(mocks.initializePlatform).toHaveBeenCalledExactlyOnceWith(projectConfig, { skipAdapterInitialization: false });
    expect(mocks.loadPlatformConfiguration.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resolveProjectConfig.mock.invocationCallOrder[0]!,
    );
    expect(mocks.resolveProjectConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.initializePlatform.mock.invocationCallOrder[0]!,
    );
    // initPlatform receives this projectRoot so built-in defaults resolve to
    // <KB_HOME>/state/<projectId>/ rather than platform-root state.
    expect(mocks.initializePlatform.mock.calls[0]![0].projectRoot).toBe(projectRoot);
  });

  // case: S-048.7
  it('uses explicit platform scope before project initialization for config commands', async () => {
    const cwd = await isolateEnvironment();
    const platformConfig = await mockConfig(cwd);
    mocks.loadPlatformConfiguration.mockResolvedValue(platformConfig);
    mockInitialization();

    await executeCli(['config', 'get', '--scope', 'platform', '--help'], { cwd, registerBuiltinCommands: () => {} });

    expect(mocks.resolveProjectConfig).not.toHaveBeenCalled();
    expect(mocks.initializePlatform).toHaveBeenCalledExactlyOnceWith(platformConfig, { skipAdapterInitialization: false });
  });

  it("uses the root-resolution project for plugin discovery while initializing adapters from platform config", async () => {
    const home = await isolateEnvironment();
    const projectRoot = path.join(home, "registered-project");
    const cwd = projectRoot;
    const platformConfig = await mockConfig(cwd);
    const registerBuiltinCommands = vi.fn();
    mocks.loadPlatformConfiguration.mockResolvedValue(platformConfig);
    mockInitialization();

    await executeCli(["hello", "--help"], {
      cwd,
      registerBuiltinCommands,
    });

    expect(mocks.initializePlatform).toHaveBeenCalledExactlyOnceWith(platformConfig, { skipAdapterInitialization: false });
    expect(mocks.resolveProjectConfig).not.toHaveBeenCalled();
    expect(registerBuiltinCommands).toHaveBeenCalledWith(expect.objectContaining({ projectRoot }));
  });

  it("resolves an unknown command in a registered project before building its command catalog", async () => {
    const home = await isolateEnvironment();
    const projectRoot = path.join(home, "registered-project");
    const cwd = projectRoot;
    mocks.loadPlatformConfiguration.mockResolvedValue(await mockConfig(projectRoot));
    mocks.resolveProjectConfig.mockResolvedValue(await mockConfig(projectRoot, 'required'));
    mockInitialization();

    await executeCli(["commit", "--help"], {
      cwd,
      registerBuiltinCommands: () => {},
    });

    expect(mocks.resolveProjectConfig).toHaveBeenCalledExactlyOnceWith(cwd, undefined);
    expect(mocks.initializePlatform).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ projectRoot, projectScope: 'required' }),
      { skipAdapterInitialization: false },
    );
  });

  it("keeps unresolved routes platform-scoped when the cwd is not a registered project", async () => {
    const cwd = await isolateEnvironment();
    const platformConfig = await mockConfig(cwd, 'platform', undefined, false);
    mocks.loadPlatformConfiguration.mockResolvedValue(platformConfig);
    mockInitialization();

    await executeCli(["commit", "--help"], {
      cwd,
      registerBuiltinCommands: () => {},
    });

    expect(mocks.resolveProjectConfig).not.toHaveBeenCalled();
    expect(mocks.initializePlatform).toHaveBeenCalledExactlyOnceWith(platformConfig, { skipAdapterInitialization: false });
  });

  it("provides the installed Gateway address to built-in command registration", async () => {
    const cwd = await isolateEnvironment();
    const gatewayUrl = "http://127.0.0.1:4820";
    await mkdir(path.join(cwd, ".kb", "v2"), { recursive: true });
    await writeFile(path.join(cwd, ".kb", "v2", "receipt.json"), JSON.stringify({
      installationId: "install-test",
      verification: { hostHealthUrl: `${gatewayUrl}/health` },
    }));
    mocks.loadPlatformConfiguration.mockResolvedValue(await mockConfig(cwd));
    mockInitialization();
    const registerBuiltinCommands = vi.fn();

    await executeCli(["hello", "--help"], { cwd, registerBuiltinCommands });

    expect(registerBuiltinCommands).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({ KB_GATEWAY_URL: gatewayUrl }),
    }));
    expect(process.env.KB_GATEWAY_URL).toBeUndefined();
  });

  it("passes the resolved Gateway address into the real built-in Marketplace handler", async () => {
    const cwd = await isolateEnvironment();
    delete process.env.KB_GATEWAY_URL;
    const env = { ...process.env };
    delete env.KB_GATEWAY_URL;
    const gatewayUrl = "http://127.0.0.1:4873";
    await createProjectRegistry({ env }).add(cwd);
    mocks.loadPlatformConfiguration.mockResolvedValue(await mockConfig(cwd));
    const platformWithTransport = {
      logger,
      getAdapter: (name: string) => name === "serviceTransport"
        ? { listenAddress: () => ({ host: "127.0.0.1", port: 4873 }) }
        : undefined,
    };
    mocks.initializePlatform.mockImplementation(async (config) => ({ ...config, platform: platformWithTransport }));
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ ok: true, total: 0, issues: [], provenance: [] }), { status: 200 });
    }));
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => { output.push(String(line)); });

    const exitCode = await executeCli(["marketplace", "plugins", "doctor", "--scope", "project", "--json"], {
      cwd,
      env,
      registerBuiltinCommands: () => {},
    });

    expect(exitCode, `${output.join("\n")}\nrequests: ${JSON.stringify(requests)}`).toBe(0);
    expect(requests).toEqual([`${gatewayUrl}/api/v1/marketplace/diagnostics?scope=project&projectRoot=${encodeURIComponent(cwd)}`]);
    expect(process.env.KB_GATEWAY_URL).toBeUndefined();
  });

  it("passes the resolved Gateway address into the built-in Workspace Agent handler", async () => {
    const cwd = await isolateEnvironment();
    delete process.env.KB_GATEWAY_URL;
    const env = { ...process.env };
    delete env.KB_GATEWAY_URL;
    const gatewayUrl = "http://127.0.0.1:4873";
    mocks.loadPlatformConfiguration.mockResolvedValue(await mockConfig(cwd));
    const platformWithTransport = {
      logger,
      getAdapter: (name: string) => name === "serviceTransport"
        ? { listenAddress: () => ({ host: "127.0.0.1", port: 4873 }) }
        : undefined,
    };
    mocks.initializePlatform.mockImplementation(async (config) => ({ ...config, platform: platformWithTransport }));
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ hosts: [] }), { status: 200 });
    }));
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => { output.push(String(line)); });

    const exitCode = await executeCli(["workspace", "list", "--json"], {
      cwd,
      env,
      registerBuiltinCommands: () => {},
    });

    expect(requests, output.join("\n")).toEqual([`${gatewayUrl}/hosts`]);
    expect(exitCode).toBe(0);
    expect(process.env.KB_GATEWAY_URL).toBeUndefined();
  });

  it("uses --gateway-url as the invocation address without changing process transport", async () => {
    const cwd = await isolateEnvironment();
    const gatewayUrl = "https://team-gateway.example.test";
    mocks.loadPlatformConfiguration.mockResolvedValue(await mockConfig(cwd));
    mockInitialization();
    const registerBuiltinCommands = vi.fn();

    await executeCli(["hello", "--gateway-url", gatewayUrl, "--help"], { cwd, registerBuiltinCommands });

    expect(registerBuiltinCommands).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({ KB_GATEWAY_URL: gatewayUrl }),
    }));
    expect(process.env.KB_GATEWAY_URL).toBeUndefined();
  });

  // case: S-203.16
  it("rejects an invalid Gateway port at the CLI bootstrap boundary", async () => {
    const cwd = await isolateEnvironment();
    delete process.env.KB_GATEWAY_URL;
    process.env.GATEWAY_PORT = "4000oops";
    mocks.loadPlatformConfiguration.mockResolvedValue(await mockConfig(cwd));
    mockInitialization();
    const registerBuiltinCommands = vi.fn();

    const exitCode = await executeCli(["hello"], { cwd, registerBuiltinCommands });

    expect(exitCode).toBe(1);
    expect(registerBuiltinCommands).not.toHaveBeenCalled();
  });

  // case: S-043.6
  it("uses a registered project root for command discovery before an unknown plugin path is dispatched", async () => {
    const home = await isolateEnvironment();
    const projectRoot = path.join(home, "registered-project");
    const cwd = projectRoot;
    const platformConfig = await mockConfig(cwd);
    const registerBuiltinCommands = vi.fn();
    mocks.loadPlatformConfiguration.mockResolvedValue(platformConfig);
    mocks.resolveProjectConfig.mockResolvedValue(await mockConfig(projectRoot, 'required'));
    mockInitialization();

    await executeCli(["commit", "plan", "show"], { cwd, registerBuiltinCommands });

    expect(mocks.resolveProjectConfig).toHaveBeenCalledExactlyOnceWith(cwd, undefined);
    expect(mocks.initializePlatform).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot, projectScope: 'required' }),
      { skipAdapterInitialization: false },
    );
    expect(registerBuiltinCommands).toHaveBeenCalledWith(expect.objectContaining({
      platformRoot: platformConfig.platformRoot,
      projectRoot,
    }));
  });

  it("skips adapter construction for global help and version without creating .kb state", async () => {
    const cwd = await isolateEnvironment();
    const platformConfig = await mockConfig(cwd);
    await platformConfig.catalog.dispose();
    fixtureCatalogs = fixtureCatalogs.filter((catalog) => catalog !== platformConfig.catalog);
    await rm(process.env.KB_HOME!, { recursive: true, force: true });
    mocks.loadPlatformConfiguration.mockResolvedValue(platformConfig);
    mockInitialization();

    for (const args of [["--help"], ["--version"]]) {
      await executeCli(args, { cwd, registerBuiltinCommands: () => {} });
    }

    expect(mocks.initializePlatform).toHaveBeenCalledTimes(2);
    expect(mocks.initializePlatform).toHaveBeenNthCalledWith(1, platformConfig, { skipAdapterInitialization: true });
    expect(mocks.initializePlatform).toHaveBeenNthCalledWith(2, platformConfig, { skipAdapterInitialization: true });
    expect(mocks.resolveProjectConfig).not.toHaveBeenCalled();
    await expect(access(path.join(cwd, ".kb"))).rejects.toThrow();
    await expect(access(process.env.KB_HOME!)).rejects.toThrow();
  });
});
