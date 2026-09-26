/**
 * Test harness: starts the real host (real `launchPlatform`, in-memory adapter
 * fallbacks) in a temp project on random high ports, then stops it through the
 * signal path it owns. Never touches the real HOME or the default ports.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { platform, resetPlatformRuntime } from "@kb-labs/core-runtime";
import type { IServiceTransport } from "@kb-labs/core-platform";
import { reserveLoopbackPorts, runHost } from "@kb-labs/shared-daemon";
import { createHostConfig, type HostOptions } from "../host.js";

export interface HostFixtureConfig {
  /** `host` section of the KB config. */
  host?: Record<string, unknown>;
  /** Extra `gateway` keys; `port` defaults to a reserved random port. */
  gateway?: Record<string, unknown>;
  /** Extra `platform` keys (adapters, adapterOptions). */
  platform?: Record<string, unknown>;
}

export interface RunningHost {
  gatewayPort: number;
  projectRoot: string;
  /** Loopback base URL of a host-internal module, as the gateway routes to it. */
  internalUrl(serviceId: string): string | undefined;
  fetchGateway(path: string, init?: RequestInit): Promise<Response>;
  /** Sends the host's own SIGTERM handler and waits for `process.exit`. */
  stop(): Promise<number>;
}

export async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export async function reservePort(): Promise<number> {
  const [port] = await reserveLoopbackPorts(1);
  return port!;
}

/** True when a bind on the loopback port succeeds, i.e. nothing holds it. */
export async function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function writeProject(
  config: HostFixtureConfig,
  gatewayPort: number,
): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "kb-host-test-"));
  await mkdir(join(projectRoot, ".kb"), { recursive: true });
  await writeFile(
    join(projectRoot, ".kb", "kb.config.json"),
    JSON.stringify({
      platform: { adapters: {}, ...config.platform },
      gateway: { port: gatewayPort, host: "127.0.0.1", ...config.gateway },
      ...(config.host ? { host: config.host } : {}),
    }),
  );
  return projectRoot;
}

/**
 * Environment the host reads: a throw-away HOME and no inherited network shift
 * or socket path. Returns the restore function.
 */
function isolateEnvironment(home: string): () => void {
  const keys = [
    "HOME",
    "USERPROFILE",
    "KB_NET_OFFSET",
    "KB_SOCKET_PATH",
    "KB_SOCKET_HASH",
    "KB_PROJECT_ROOT",
    "KB_PLATFORM_ROOT",
  ] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const key of keys.slice(2)) {
    delete process.env[key];
  }
  // Vitest forks its workers with an IPC channel, which launchPlatform reads
  // as "sandbox child process" and answers with proxy adapters. The host is a
  // top-level process, so hide the channel while it is launched.
  const send = process.send;
  process.send = undefined;
  return () => {
    process.send = send;
    for (const [key, value] of saved) {
      if (value === undefined) {delete process.env[key];}
      else {process.env[key] = value;}
    }
  };
}

export async function startTestHost(
  config: HostFixtureConfig = {},
  hostOptions: HostOptions = {},
): Promise<RunningHost> {
  const gatewayPort = await reservePort();
  const projectRoot = await writeProject(config, gatewayPort);
  const restoreEnv = isolateEnvironment(projectRoot);

  const exitCodes: number[] = [];
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    exitCodes.push(typeof code === "number" ? code : 0);
    return undefined as never;
  });
  const termBefore = new Set(process.listeners("SIGTERM"));
  const intBefore = new Set(process.listeners("SIGINT"));

  // launchPlatform is idempotent per process and shutdown does not clear it, so
  // every host starts from a clean process-wide platform.
  resetPlatformRuntime();

  const cleanup = async (): Promise<void> => {
    resetPlatformRuntime();
    exitSpy.mockRestore();
    restoreEnv();
    await rm(projectRoot, { recursive: true, force: true });
  };

  try {
    await runHost(
      await createHostConfig({ ...hostOptions, startDir: projectRoot }),
    );
  } catch (error) {
    await cleanup();
    throw error;
  }

  const handlers = process
    .listeners("SIGTERM")
    .filter((listener) => !termBefore.has(listener));
  let stopped: Promise<number> | undefined;

  return {
    gatewayPort,
    projectRoot,
    internalUrl(serviceId) {
      return platform
        .getAdapter<IServiceTransport>("serviceTransport")
        ?.connectionInfo(serviceId)?.baseUrl;
    },
    fetchGateway(path, init) {
      return fetch(`http://127.0.0.1:${gatewayPort}${path}`, init);
    },
    stop() {
      stopped ??= (async () => {
        for (const handler of handlers) {
          process.removeListener("SIGTERM", handler);
          await Reflect.apply(handler, process, []);
        }
        const deadline = Date.now() + 15_000;
        while (exitCodes.length === 0 && Date.now() < deadline) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 20);
          });
        }
        // runHost also registered a SIGINT handler; drop it with the run.
        for (const listener of process.listeners("SIGINT")) {
          if (!intBefore.has(listener)) {process.removeListener("SIGINT", listener);}
        }
        await cleanup();
        if (exitCodes.length === 0) {
          throw new Error("host did not exit after SIGTERM");
        }
        return exitCodes[0]!;
      })();
      return stopped;
    },
  };
}
