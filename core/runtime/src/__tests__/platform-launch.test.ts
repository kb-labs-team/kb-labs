import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectRegistry } from "@kb-labs/core-project-registry";
import { platform } from "../container.js";
import { launchPlatform, resetPlatformRuntime } from "../platform-launch.js";
import { writeTestPlatformReceipt } from './platform-version-fixture.js';

const observed = vi.hoisted(() => ({ workspaceRoot: undefined as string | undefined }));
vi.mock("../loader.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../loader.js")>();
  return {
    ...real,
    initPlatform: (...args: Parameters<typeof real.initPlatform>) => {
      observed.workspaceRoot = args[4]?.workspaceRoot;
      return real.initPlatform(...args);
    },
  };
});

const assemblyHook = (
  _raw: object,
  _broker: unknown,
  config: Partial<Record<string, unknown>>,
) => config;

describe("launchPlatform", () => {
  let projectRoot: string;
  let kbHome: string;
  let previousHome: string | undefined;
  let previousKbHome: string | undefined;
  let previousPlatformRoot: string | undefined;
  let previousSocketHash: string | undefined;

  beforeEach(async () => {
    resetPlatformRuntime();
    projectRoot = await mkdtemp(path.join(tmpdir(), "kb-platform-launch-"));
    writeTestPlatformReceipt(projectRoot);
    kbHome = await mkdtemp(path.join(tmpdir(), "kb-platform-launch-home-"));
    previousHome = process.env.HOME;
    previousKbHome = process.env.KB_HOME;
    previousPlatformRoot = process.env.KB_PLATFORM_ROOT;
    process.env.KB_PLATFORM_ROOT = projectRoot;
    process.env.HOME = kbHome;
    process.env.KB_HOME = kbHome;
    await createProjectRegistry({ root: kbHome }).add(projectRoot);
    await mkdir(path.join(projectRoot, '.kb'), { recursive: true });
    await writeFile(path.join(projectRoot, '.kb', 'kb.config.json'), JSON.stringify({
      platform: { deployment: { topology: 'local' } },
    }));
    previousSocketHash = process.env.KB_SOCKET_HASH;
    delete process.env.KB_SOCKET_HASH;
  });

  afterEach(async () => {
    resetPlatformRuntime();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(kbHome, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousKbHome === undefined) delete process.env.KB_HOME; else process.env.KB_HOME = previousKbHome;
    if (previousPlatformRoot === undefined) delete process.env.KB_PLATFORM_ROOT; else process.env.KB_PLATFORM_ROOT = previousPlatformRoot;
    delete process.env.PLATFORM_LAUNCH_TEST;
    if (previousSocketHash === undefined) {
      delete process.env.KB_SOCKET_HASH;
    } else {
      process.env.KB_SOCKET_HASH = previousSocketHash;
    }
  });

  // case: S-287.5
  it("uses the platform workspace when a service launches for a separate project", async () => {
    const platformRoot = await mkdtemp(path.join(tmpdir(), "kb-launch-owner-"));
    try {
      writeTestPlatformReceipt(platformRoot);
      await mkdir(path.join(platformRoot, '.kb'), { recursive: true });
      await writeFile(path.join(platformRoot, '.kb', 'kb.config.json'), JSON.stringify({
        platform: { mode: 'development', deployment: { topology: 'local' } },
      }));
      await mkdir(path.join(projectRoot, 'adapters', 'project-only'), { recursive: true });
      await writeFile(path.join(projectRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "adapters/*"\n');
      await writeFile(path.join(projectRoot, 'adapters', 'project-only', 'package.json'), JSON.stringify({
        name: '@example/project-only', version: '1.0.0', kb: { adapter: { manifest: './dist/manifest.js' } },
      }));
      process.env.KB_PLATFORM_ROOT = platformRoot;
      const runtime = await launchPlatform({ applicationId: 'separate-service', kind: 'service', startDir: projectRoot, assemblyHook });
      expect(runtime.roots.projectRoot).toBe(await realpath(projectRoot));
      expect(runtime.catalog.adapters().has('@example/project-only')).toBe(false);
      expect(await realpath(observed.workspaceRoot!)).toBe(await realpath(platformRoot));
    } finally {
      await rm(platformRoot, { recursive: true, force: true });
    }
  });

  it("owns config, env and platform initialisation for a service", async () => {
    await writeFile(
      path.join(projectRoot, ".env"),
      "PLATFORM_LAUNCH_TEST=value\n",
    );
    delete process.env.PLATFORM_LAUNCH_TEST;

    const runtime = await launchPlatform({
      applicationId: "test-service",
      kind: "service",
      startDir: projectRoot,
      assemblyHook,
    });

    expect(runtime.platform).toBe(platform);
    expect(runtime.roots.projectRoot).toBe(await realpath(projectRoot));
    expect(process.env.PLATFORM_LAUNCH_TEST).toBe("value");
    expect(process.env.KB_SOCKET_HASH).toMatch(/^[0-9a-f]{8}$/);
    expect(runtime.startupReport.applicationId).toBe("test-service");
  });

  it('refuses service startup when the delivery producer omits topology', async () => {
    await writeFile(path.join(projectRoot, '.kb', 'kb.config.json'), JSON.stringify({ platform: {} }));
    await expect(launchPlatform({
      applicationId: 'missing-topology-service',
      kind: 'service',
      startDir: projectRoot,
      assemblyHook,
    })).rejects.toMatchObject({
      envelope: { code: 'KB_DEPLOYMENT_TOPOLOGY_REQUIRED' },
    });
  });

  it("is idempotent for one application identity", async () => {
    const first = await launchPlatform({
      applicationId: "test-service",
      kind: "service",
      startDir: projectRoot,
      assemblyHook,
    });
    const second = await launchPlatform({
      applicationId: "test-service",
      kind: "service",
      startDir: projectRoot,
      assemblyHook,
    });

    expect(second).toBe(first);
  });

  it("rejects a second application identity in one process", async () => {
    await launchPlatform({
      applicationId: "first-service",
      kind: "service",
      startDir: projectRoot,
      assemblyHook,
    });

    await expect(
      launchPlatform({
        applicationId: "second-service",
        kind: "service",
        startDir: projectRoot,
        assemblyHook,
      }),
    ).rejects.toThrow("Platform is already launched");
  });
});
