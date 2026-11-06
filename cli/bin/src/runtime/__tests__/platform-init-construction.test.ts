import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { discoverAdapters, isWorkspaceDevelopmentMode, loadPlatformConfig } from "@kb-labs/core-runtime";
import type { LoadPlatformConfigResult } from "@kb-labs/core-runtime";

const mocks = vi.hoisted(() => {
  const logger = {
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return logger; },
  };
  const platform = {
    logger,
    isInitialized: false,
    registerLifecycleHooks: vi.fn(),
  };
  return { initPlatform: vi.fn(), platform };
});

vi.mock("@kb-labs/core-runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("@kb-labs/core-runtime")>(),
  initPlatform: mocks.initPlatform,
  platform: mocks.platform,
}));

import { initializePlatform } from "../platform-init.js";

describe("CLI adapter construction", () => {
  let catalog: LoadPlatformConfigResult['catalog'] | undefined;
  let catalogRoot: string | undefined;

  afterEach(async () => {
    const openedCatalog = catalog;
    const root = catalogRoot;
    catalog = undefined;
    catalogRoot = undefined;
    try {
      await openedCatalog?.dispose();
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
      vi.clearAllMocks();
    }
  });

  async function projectConfig(projectRoot: string, projectScope: 'required' | 'platform' = 'required'): Promise<LoadPlatformConfigResult> {
    catalogRoot = await mkdtemp(path.join(tmpdir(), 'cli-platform-init-catalog-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: catalogRoot,
      KB_HOME: path.join(catalogRoot, '.kb'),
      KB_PLATFORM_ROOT: catalogRoot,
    };
    delete env.KB_PROJECT_ROOT;
    delete env.KB_PROJECT_ID;
    const loaded = await loadPlatformConfig({
      startDir: catalogRoot,
      env,
      loadEnvFile: false,
      projectScope: 'platform',
    });
    catalog = loaded.catalog;
    return {
      ...loaded,
      catalog,
      platformConfig: { adapters: { storage: "@kb-labs/adapters-fs" } },
      platformRoot: "/installed/platform",
      projectRoot,
      projectScope,
      sameLocation: false,
      sources: { roots: { platform: "env", project: "registry", projectStartDir: projectRoot }, fields: {} },
    };
  }

  it("constructs adapters once using the resolved project root for per-project defaults", async () => {
    const projectRoot = "/workspace/app";
    const config = await projectConfig(projectRoot);
    const initializedPlatform = { ...mocks.platform, logger: mocks.platform.logger };
    mocks.initPlatform.mockResolvedValue(initializedPlatform);

    const result = await initializePlatform(config);

    expect(mocks.initPlatform).toHaveBeenCalledTimes(1);
    expect(mocks.initPlatform).toHaveBeenCalledWith(
      config.platformConfig,
      projectRoot,
      expect.any(Function),
      "/installed/platform",
      expect.objectContaining({ workspaceDevelopment: false }),
    );
    expect(result.projectRoot).toBe(projectRoot);
  });

  it("does not construct adapters for global help or version", async () => {
    const config = await projectConfig("/installed/platform");

    const result = await initializePlatform(config, { skipAdapterInitialization: true });

    expect(mocks.initPlatform).not.toHaveBeenCalled();
    expect(result.platform).toBe(mocks.platform);
  });

  it("keeps platform-scoped adapters at the platform root while preserving project identity", async () => {
    const projectRoot = "/workspace/app";
    const config = await projectConfig(projectRoot, 'platform');
    mocks.initPlatform.mockResolvedValue(mocks.platform);

    const result = await initializePlatform(config);

    expect(mocks.initPlatform).toHaveBeenCalledWith(
      config.platformConfig,
      "/installed/platform",
      expect.any(Function),
      undefined,
      expect.objectContaining({ workspaceDevelopment: false }),
    );
    expect(result.projectRoot).toBe(projectRoot);
  });

  async function loadWorkspaceConfigFromCommitSubdirectory() {
    const workspaceRoot = path.resolve(process.cwd(), "../..");
    const invocationDir = path.join(workspaceRoot, "plugins/commit");
    const home = await mkdtemp(path.join(tmpdir(), "cli-workspace-root-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      KB_HOME: path.join(home, ".kb"),
      KB_PLATFORM_ROOT: workspaceRoot,
    };
    delete env.KB_PROJECT_ROOT;
    delete env.KB_PROJECT_ID;
    const config = await loadPlatformConfig({
      startDir: invocationDir,
      env,
      loadEnvFile: false,
      projectScope: "platform",
    });
    const projectRoot = config.projectRoot;
    if (!projectRoot) throw new Error("config resolver did not return a project root for the development config");
    return { config, home, invocationDir, projectRoot, workspaceRoot };
  }

  it("takes workspace discovery root from the config resolver result", async () => {
    const { config, home, invocationDir, projectRoot, workspaceRoot } = await loadWorkspaceConfigFromCommitSubdirectory();
    try {
      expect(projectRoot).toBe(workspaceRoot);
      expect(config.sources.roots.projectStartDir).toBe(invocationDir);
      expect(isWorkspaceDevelopmentMode(config)).toBe(true);
      mocks.initPlatform.mockResolvedValue(mocks.platform);

      await initializePlatform(config);

      expect(mocks.initPlatform).toHaveBeenCalledWith(
        config.platformConfig,
        config.platformRoot,
        expect.any(Function),
        undefined,
        expect.objectContaining({
          workspaceDevelopment: true,
          workspaceRoot: projectRoot,
        }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("discovers a workspace adapter from a subdirectory invocation without gateway access", async () => {
    const { config, home, invocationDir, projectRoot, workspaceRoot } = await loadWorkspaceConfigFromCommitSubdirectory();
    try {
      expect(config.sources.roots.projectStartDir).toBe(invocationDir);
      expect(projectRoot).toBe(workspaceRoot);
      mocks.initPlatform.mockResolvedValue(mocks.platform);
      await initializePlatform(config);

      const storageBinding = config.platformConfig.adapters?.storage;
      const storagePackage = Array.isArray(storageBinding) ? storageBinding[0] : storageBinding;
      expect(storagePackage).toBeTruthy();
      const packageName = storagePackage!.split("/").slice(0, 2).join("/");
      const discovered = await discoverAdapters(config.platformRoot, {
        development: true,
        workspaceRoot: projectRoot,
        configuredPackages: [{ packageName, slot: "storage" }],
      });
      expect(discovered.has(packageName)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
