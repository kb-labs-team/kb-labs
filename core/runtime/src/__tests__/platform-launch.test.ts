import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectRegistry } from "@kb-labs/core-project-registry";
import { platform } from "../container.js";
import { launchPlatform, resetPlatformRuntime } from "../platform-launch.js";
import { writeTestPlatformReceipt } from './platform-version-fixture.js';

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
  let previousSocketHash: string | undefined;

  beforeEach(async () => {
    resetPlatformRuntime();
    projectRoot = await mkdtemp(path.join(tmpdir(), "kb-platform-launch-"));
    writeTestPlatformReceipt(projectRoot);
    kbHome = await mkdtemp(path.join(tmpdir(), "kb-platform-launch-home-"));
    previousHome = process.env.HOME;
    previousKbHome = process.env.KB_HOME;
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
    vi.restoreAllMocks();
    resetPlatformRuntime();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(kbHome, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousKbHome === undefined) delete process.env.KB_HOME; else process.env.KB_HOME = previousKbHome;
    delete process.env.PLATFORM_LAUNCH_TEST;
    if (previousSocketHash === undefined) {
      delete process.env.KB_SOCKET_HASH;
    } else {
      process.env.KB_SOCKET_HASH = previousSocketHash;
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

  // case: S-317.1
  it('reports a safe startup failure when the delivery producer omits topology', async () => {
    await writeFile(path.join(projectRoot, '.kb', 'kb.config.json'), JSON.stringify({
      platform: {},
      token: 'startup-secret-sentinel',
    }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(launchPlatform({
      applicationId: 'missing-topology-service',
      kind: 'service',
      startDir: projectRoot,
      assemblyHook,
    })).rejects.toMatchObject({
      envelope: { code: 'KB_DEPLOYMENT_TOPOLOGY_REQUIRED' },
    });

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('Platform startup failed');
    expect(output).toContain('"event":"platform.failed"');
    expect(output).toContain('"errorCode":"KB_DEPLOYMENT_TOPOLOGY_REQUIRED"');
    expect(output).toContain('"failureMessage":"The platform deployment topology is missing from platform.deployment.topology."');
    expect(output).toContain('"remediationHint":"Set platform.deployment.topology in the producer configuration: kb-create writes local, release images provide cloud, and Helm writes k8s."');
    expect(output.match(/platform\.failed/g)).toHaveLength(1);
    expect(output).not.toContain('stack');
    expect(output).not.toContain('startup-secret-sentinel');
  });

  it('does not duplicate startup failures already reported by lifecycle hooks', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(launchPlatform({
      applicationId: 'assembly-failure-service',
      kind: 'service',
      startDir: projectRoot,
      assemblyHook: () => {
        throw new Error('assembly setup failed');
      },
    })).rejects.toThrow('assembly setup failed');

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output.match(/platform\.failed/g)).toHaveLength(1);
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
