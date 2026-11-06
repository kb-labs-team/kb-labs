/**
 * @module @kb-labs/host-app/project-runtime/launcher
 *
 * Starts a project runtime as a child process of the host.
 *
 * - Address: a loopback ephemeral port chosen here; nothing is written in
 *   config and no `KB_NET_OFFSET` is involved.
 * - Secret: a fresh random token per process, passed through the environment
 *   (argv is visible to every local user) and demanded by the runtime on
 *   every request.
 * - No orphans: the child leads its own process group, and `stop()` signals
 *   the whole group (a taskkill tree on Windows), so processes the runtime
 *   spawned go with it. The runtime also watches the host pid and exits when
 *   the host is killed without a chance to stop it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { LOOPBACK_HOST, reserveLoopbackPorts } from "@kb-labs/shared-daemon";
import {
  RUNTIME_ARGS,
  RUNTIME_HEALTH_PATH,
  RUNTIME_TOKEN_ENV,
  RUNTIME_TOKEN_HEADER,
} from "@kb-labs/project-runtime-app/protocol";
import type {
  RuntimeExit,
  RuntimeLauncher,
  RuntimeProcess,
  RuntimeProject,
} from "./manager.js";

const OUTPUT_TAIL_BYTES = 256 * 1024;
const HEALTH_STATUS_BYTES = 4 * 1024;

/**
 * Variables that would make a runtime bind or resolve something the host owns
 * or another project owns.
 */
const STRIPPED_ENV = [
  "KB_NET_OFFSET",
  "KB_SOCKET_PATH",
  "KB_SOCKET_HASH",
  "REST_API_HOST",
  "REST_API_PORT",
  "WORKFLOW_HOST",
  "WORKFLOW_PORT",
  "KB_PROJECT_ROOT",
] as const;

export interface ChildProcessLauncherOptions {
  /** The runtime script to run with node (the `kb-project-runtime` bin). */
  entry: string;
  /** Extra environment for the runtime, e.g. `KB_PLATFORM_ROOT`. */
  env?: NodeJS.ProcessEnv;
  /** Base environment; defaults to the host's. */
  baseEnv?: NodeJS.ProcessEnv;
  execPath?: string;
  execArgv?: readonly string[];
  /** Pid the runtime watches; defaults to this process. */
  hostPid?: number;
  /** SIGTERM grace period before SIGKILL. */
  stopTimeoutMs?: number;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

class ChildRuntime implements RuntimeProcess {
  readonly exited: Promise<RuntimeExit>;
  private output = "";
  private healthStatus = "";
  private done = false;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly child: ChildProcess,
    readonly address: { host: string; port: number },
    readonly token: string,
    private readonly stopTimeoutMs: number,
  ) {
    const collect = (chunk: Buffer): void => {
      this.output = (this.output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_BYTES);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    this.exited = new Promise<RuntimeExit>((resolve) => {
      child.once("exit", (code, signal) => {
        this.done = true;
        // Processes the runtime spawned may outlive it (a crash, a SIGKILL of
        // the leader): end the group right away, while its id cannot have been
        // recycled. During an orderly stop, terminate() owns the process-tree
        // grace period and will kill only descendants that remain afterward.
        if (!this.stopping) {
          this.reapGroup();
        }
        resolve({ code, signal });
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  outputTail(): string {
    return this.output;
  }

  recordHealthStatus(statusCode: number, body: string): void {
    this.healthStatus = `HTTP ${statusCode}: ${body.slice(0, HEALTH_STATUS_BYTES)}`;
  }

  lastHealthStatus(): string {
    return this.healthStatus;
  }

  stop(): Promise<void> {
    this.stopping ??= this.terminate();
    return this.stopping;
  }

  private signalTree(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) {
      return;
    }
    if (isWindows()) {
      // No process groups: kill the tree, forcefully (there is no SIGTERM).
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", () => this.child.kill(signal));
      return;
    }
    try {
      // Negative pid: the whole group the child leads.
      process.kill(-pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  private async terminate(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined) {
      if (!this.done) {
        this.signalTree("SIGTERM");
        await this.exited;
      }
      return;
    }
    if (isWindows()) {
      if (!this.done) {
        this.signalTree("SIGTERM");
        await this.exited;
      }
      return;
    }

    const deadline = Date.now() + this.stopTimeoutMs;
    if (!this.done) {
      this.signalTree("SIGTERM");
    }
    while (!this.done || this.isGroupAlive(pid)) {
      if (Date.now() >= deadline) {
        this.reapGroup();
        const killDeadline = Date.now() + this.stopTimeoutMs;
        while (!this.done || this.isGroupAlive(pid)) {
          if (Date.now() >= killDeadline) {
            throw new Error(
              `Project runtime process group ${pid} did not stop within ${this.stopTimeoutMs} ms after SIGKILL`,
            );
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await this.exited;
  }

  private isGroupAlive(pid: number): boolean {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return false;
      }
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return true;
      }
      throw error;
    }
  }

  /** Ends whatever is left of the process group after the leader is gone. */
  private reapGroup(): void {
    if (!isWindows()) {
      this.signalTree("SIGKILL");
    }
  }
}

/** True when the runtime answers `GET /__runtime/health` with 200 and its secret is accepted. */
export function probeRuntime(runtime: RuntimeProcess): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: runtime.address.host,
        port: runtime.address.port,
        path: RUNTIME_HEALTH_PATH,
        method: "GET",
        headers: { [RUNTIME_TOKEN_HEADER]: runtime.token },
        timeout: 2000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          if (bytes >= HEALTH_STATUS_BYTES) {
            return;
          }
          const remaining = HEALTH_STATUS_BYTES - bytes;
          const bounded = chunk.subarray(0, remaining);
          chunks.push(bounded);
          bytes += bounded.length;
        });
        res.once("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if ("recordHealthStatus" in runtime && typeof runtime.recordHealthStatus === "function") {
            runtime.recordHealthStatus(res.statusCode ?? 0, body);
          }
          resolve(res.statusCode === 200);
        });
      },
    );
    req.once("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.once("error", () => resolve(false));
    req.end();
  });
}

export function createChildProcessLauncher(
  options: ChildProcessLauncherOptions,
): RuntimeLauncher {
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
  return {
    async launch(project: RuntimeProject): Promise<RuntimeProcess> {
      const [port] = await reserveLoopbackPorts(1);
      const token = randomBytes(32).toString("hex");
      const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env) };
      for (const name of STRIPPED_ENV) {
        delete env[name];
      }
      Object.assign(env, options.env, {
        KB_PROJECT_ROOT: project.root,
        [RUNTIME_TOKEN_ENV]: token,
      });

      const child = spawn(
        options.execPath ?? process.execPath,
        [
          ...(options.execArgv ?? []),
          options.entry,
          RUNTIME_ARGS.projectRoot,
          project.root,
          RUNTIME_ARGS.projectId,
          project.id,
          RUNTIME_ARGS.listen,
          `${LOOPBACK_HOST}:${port}`,
          RUNTIME_ARGS.parentPid,
          String(options.hostPid ?? process.pid),
        ],
        {
          cwd: project.root,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: !isWindows(),
          windowsHide: true,
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      // After a successful spawn, later errors (a failed kill) are not fatal.
      child.on("error", () => undefined);
      return new ChildRuntime(
        child,
        { host: LOOPBACK_HOST, port: port! },
        token,
        stopTimeoutMs,
      );
    },
    probe: probeRuntime,
  };
}
