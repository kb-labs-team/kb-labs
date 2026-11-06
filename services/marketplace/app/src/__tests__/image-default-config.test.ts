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
}));

vi.mock("@kb-labs/plugin-runtime", () => ({ makeAssemblyHook: vi.fn() }));
vi.mock("@kb-labs/shared-http", () => ({ getListenOptions: vi.fn(() => ({})) }));
vi.mock("@kb-labs/shared-daemon", () => ({ runService: vi.fn() }));
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
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  tempRoot = "";
  vi.clearAllMocks();
});

describe("Marketplace image default config", () => {
  // case: S-268.11
  it("resolves generated release sources during Marketplace setup", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kb-marketplace-image-default-"));
    const configPath = path.join(tempRoot, ".kb", "kb.config.json");
    execFileSync(process.execPath, [producerPath, configPath], { cwd: workspaceRoot });
    const generatedConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as { marketplace: { sources: Array<{ url: string }> } };
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
  });
});
