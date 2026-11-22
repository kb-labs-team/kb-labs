import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({
  createServer: vi.fn(),
  MarketplaceService: vi.fn(),
  createExtensionStore: vi.fn(),
  requireEnvironmentSecret: vi.fn(() => "fixture-internal-secret"),
}));

vi.mock("@kb-labs/plugin-runtime", () => ({ makeAssemblyHook: vi.fn() }));
vi.mock("@kb-labs/shared-http", () => ({ getListenOptions: vi.fn(() => ({})) }));
vi.mock("@kb-labs/shared-daemon", () => ({ runService: vi.fn(), requireEnvironmentSecret: mocks.requireEnvironmentSecret }));
vi.mock("@kb-labs/marketplace-api", () => ({ createServer: mocks.createServer }));
vi.mock("@kb-labs/marketplace-core", () => ({ MarketplaceService: mocks.MarketplaceService }));
vi.mock("@kb-labs/core-extension-store", () => ({ createExtensionStore: mocks.createExtensionStore }));
vi.mock("@kb-labs/marketplace-npm", () => ({
  NpmPackageSource: class NpmPackageSource { constructor(public options: unknown) {} },
  RegistryPackageSource: class RegistryPackageSource { constructor(public options: unknown) {} },
}));

const workspaceRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const producerPath = path.join(workspaceRoot, "tools/release/generate-platform-image-default.mjs");
let tempRoot = "";

afterEach(async () => {
  if (tempRoot) {await fs.rm(tempRoot, { recursive: true, force: true });}
  tempRoot = "";
  vi.clearAllMocks();
});

describe("Marketplace image default config", () => {
  // case: S-268.11
  it("resolves generated release sources during Marketplace setup", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kb-marketplace-image-default-"));
    const configPath = path.join(tempRoot, ".kb", "kb.config.json");
    execFileSync(process.execPath, [producerPath, configPath], { cwd: workspaceRoot });
    const generatedConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as { marketplace: { sources: Array<{ url: string }> }; gateway: { access: { mode: string } } };
    mocks.createServer.mockResolvedValue({ listen: vi.fn(), close: vi.fn() });
    mocks.MarketplaceService.mockImplementation(function (options) { return options; });
    mocks.createExtensionStore.mockReturnValue({});

    const { setup } = await import("../bootstrap.js");
    const context = {
      logger: { info: vi.fn() },
      port: 5070,
      host: "127.0.0.1",
      platformRoot: tempRoot,
      netOffset: 0,
      platform: {},
      runtime: {},
    } as unknown as Parameters<typeof setup>[0];
    await expect(setup(context)).resolves.toBeTypeOf("function");

    expect(mocks.MarketplaceService).toHaveBeenCalledWith(expect.objectContaining({
      sources: [expect.objectContaining({ options: { registryUrl: generatedConfig.marketplace.sources[0]?.url } })],
    }));
    expect(mocks.createServer).toHaveBeenCalledWith(expect.objectContaining({
      auth: { internalSecret: "fixture-internal-secret", projectScopeAllowed: false },
    }));
  });

  // case: S-038.1, S-038.3
  it("requires the Gateway secret in local mode before starting", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kb-marketplace-local-secret-"));
    const configPath = path.join(tempRoot, ".kb", "kb.config.json");
    execFileSync(process.execPath, [producerPath, configPath], { cwd: workspaceRoot });
    const localConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      gateway: { access: { mode: string }; auth: { enabled?: boolean } };
    };
    localConfig.gateway.access.mode = "local";
    localConfig.gateway.auth.enabled = false;
    await fs.writeFile(configPath, JSON.stringify(localConfig));
    mocks.requireEnvironmentSecret.mockImplementation(() => {
      throw new Error("KB_CONFIG_SECRET_MISSING: GATEWAY_INTERNAL_SECRET");
    });

    const { setup } = await import("../bootstrap.js");
    const context = {
      logger: { info: vi.fn() },
      port: 5070,
      host: "127.0.0.1",
      platformRoot: tempRoot,
      netOffset: 0,
      platform: {},
      runtime: {},
    } as unknown as Parameters<typeof setup>[0];
    await expect(setup(context)).rejects.toThrow("KB_CONFIG_SECRET_MISSING: GATEWAY_INTERNAL_SECRET");
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  // case: S-269.11
  it("allows project Marketplace scope only for the local single-user topology", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kb-marketplace-scope-policy-"));
    const configPath = path.join(tempRoot, ".kb", "kb.config.json");
    execFileSync(process.execPath, [producerPath, configPath], { cwd: workspaceRoot });
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      gateway: { access: { mode: string } };
      platform: { deployment: { topology: string } };
    };
    config.gateway.access.mode = "local";
    config.platform.deployment.topology = "local";
    await fs.writeFile(configPath, JSON.stringify(config));
    mocks.requireEnvironmentSecret.mockReturnValue("fixture-internal-secret");
    mocks.createServer.mockResolvedValue({ listen: vi.fn(), close: vi.fn() });
    mocks.MarketplaceService.mockImplementation(function (options) { return options; });
    mocks.createExtensionStore.mockReturnValue({});

    const { setup } = await import("../bootstrap.js");
    const context = {
      logger: { info: vi.fn() }, port: 5070, host: "127.0.0.1", platformRoot: tempRoot,
      netOffset: 0, platform: {}, runtime: {},
    } as unknown as Parameters<typeof setup>[0];
    await setup(context);
    expect(mocks.createServer).toHaveBeenLastCalledWith(expect.objectContaining({
      auth: { internalSecret: "fixture-internal-secret", projectScopeAllowed: true },
    }));

    config.platform.deployment.topology = "k8s";
    await fs.writeFile(configPath, JSON.stringify(config));
    await setup(context);
    expect(mocks.createServer).toHaveBeenLastCalledWith(expect.objectContaining({
      auth: { internalSecret: "fixture-internal-secret", projectScopeAllowed: false },
    }));
  });
});
