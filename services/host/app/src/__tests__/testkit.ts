/**
 * Shared helpers for the project-runtime tests: temp projects driven by the
 * fake runtime fixture, a silent logger, process liveness checks. Everything
 * lives in temp directories; nothing touches the real HOME or default ports.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContextLogger, type IContextLogger } from "@kb-labs/core-platform";
import { NoOpLogger } from "@kb-labs/core-platform/noop";
import {
  canonicalizeProjectPath,
  deriveProjectId,
} from "@kb-labs/core-project-registry";
import { RUNTIME_TOKEN_HEADER } from "@kb-labs/project-runtime-app/protocol";
import type { RuntimeLease, RuntimeProject } from "../project-runtime/manager.js";

export const FAKE_RUNTIME_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-runtime.mjs",
);

export function silentLogger(): IContextLogger {
  return createContextLogger(new NoOpLogger(), {
    applicationId: "host-test",
    serviceId: "host-test",
    instanceId: "test",
    layer: "service",
  });
}

export interface FakeBehavior {
  exitBeforeReady?: number;
  startDelayMs?: number;
  unhealthyAfterMs?: number;
  ignoreSigterm?: boolean;
}

export interface TestProject extends RuntimeProject {
  /** Rewrites the behavior file the fake runtime reads at start. */
  behave(behavior: FakeBehavior): Promise<void>;
  cleanup(): Promise<void>;
}

export async function makeProject(
  behavior: FakeBehavior = {},
): Promise<TestProject> {
  const dir = await mkdtemp(join(tmpdir(), "kb-runtime-test-"));
  await mkdir(join(dir, ".kb"), { recursive: true });
  const root = await canonicalizeProjectPath(dir);
  const behaviorFile = join(root, "fake-runtime.json");
  await writeFile(behaviorFile, JSON.stringify(behavior));
  return {
    id: deriveProjectId(root),
    root,
    behave: (next) => writeFile(behaviorFile, JSON.stringify(next)),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export interface FakeRuntimeReply {
  projectId: string;
  projectRoot: string;
  pid: number;
  method: string;
  path: string;
  search: string;
  body: string;
  received: {
    tokenHeader: string | null;
    projectHeader: string | null;
    authorization: string | null;
  };
}

/** Calls the fake runtime directly with the lease's secret. */
export async function callRuntime(
  lease: RuntimeLease,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`http://${lease.address.host}:${lease.address.port}${path}`, {
    ...init,
    headers: { [RUNTIME_TOKEN_HEADER]: lease.token, ...init.headers },
  });
}
