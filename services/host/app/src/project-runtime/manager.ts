/**
 * @module @kb-labs/host-app/project-runtime/manager
 *
 * Supervises project runtimes (ADR-0043, model B): one process per active
 * project, started lazily on the first request for it.
 *
 * - `acquire` starts the runtime on demand, reuses a running one, and counts
 *   the request as in flight until its lease is released.
 * - A runtime with no request in flight for `idleTimeoutMs` is stopped.
 * - At most `maxActiveProjects` runtimes are active. A new project evicts the
 *   least recently used idle runtime; when every runtime is busy the request
 *   fails with `KB_PROJECT_RUNTIME_LIMIT`.
 * - A runtime that dies or stops answering health checks is restarted with
 *   exponential backoff; after `maxAttempts` consecutive failures it is given
 *   up until the next request asks for it again.
 * - `stopAll` stops every runtime and waits for the processes to be gone.
 *
 * The manager knows nothing about how a runtime is started (see
 * {@link RuntimeLauncher}) or about the registry; it deals in project ids and
 * roots.
 */

import type { IContextLogger } from "@kb-labs/core-platform";
import { runtimeLimitReached, runtimeStartFailed } from "./errors.js";

export interface RuntimeProject {
  id: string;
  /** Canonical absolute project root. */
  root: string;
}

export interface RuntimeAddress {
  host: string;
  port: number;
}

export interface RuntimeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A started runtime process, as far as the manager is concerned. */
export interface RuntimeProcess {
  pid: number | undefined;
  address: RuntimeAddress;
  /** Shared secret the runtime demands on every request. */
  token: string;
  /** Resolves once, when the process is gone. Never rejects. */
  exited: Promise<RuntimeExit>;
  /** Stops the process and everything it spawned; resolves when it is gone. */
  stop(): Promise<void>;
  /** Last output of the process, for the cause of a failed start. */
  outputTail(): string;
}

export interface RuntimeLauncher {
  /** Spawns the runtime. Does not wait for it to become healthy. */
  launch(project: RuntimeProject): Promise<RuntimeProcess>;
  /** True when the runtime answers its health check. */
  probe(runtime: RuntimeProcess): Promise<boolean>;
}

export interface RestartPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Consecutive failed restarts before the runtime is given up. */
  maxAttempts: number;
  /** A runtime that stayed up this long starts over with a fresh attempt count. */
  resetAfterMs: number;
}

export type RuntimeState = "starting" | "ready" | "restarting" | "stopping";

export interface RuntimeLease {
  projectId: string;
  address: RuntimeAddress;
  token: string;
  /** Ends the request; idempotent. */
  release(): void;
}

export interface RuntimeSnapshot {
  projectId: string;
  /** `failed` is reported for a project whose runtime was given up. */
  state: RuntimeState | "failed";
  lastUsedAt: string;
  inflight: number;
  restarts: number;
  pid?: number;
  address?: RuntimeAddress;
  /** Cause of the last failure, for logs and diagnostics (may contain paths). */
  lastError?: string;
}

export interface ManagerSnapshot {
  limit: number;
  /** Runtimes that are starting, running or restarting. */
  active: number;
  runtimes: RuntimeSnapshot[];
}

export interface ProjectRuntimeManagerOptions {
  launcher: RuntimeLauncher;
  logger: IContextLogger;
  maxActiveProjects: number;
  /** A runtime without requests in flight this long is stopped; 0 disables it. */
  idleTimeoutMs: number;
  /** How long a runtime may take to become healthy. */
  startTimeoutMs: number;
  /** Poll interval while waiting for a runtime to become healthy. */
  startPollMs?: number;
  /** Interval between health checks of a running runtime. */
  healthIntervalMs?: number;
  /** Consecutive failed health checks after which a runtime is killed and restarted. */
  healthFailureThreshold?: number;
  /** Interval of the idle sweep. */
  sweepIntervalMs?: number;
  restart?: Partial<RestartPolicy>;
  /** Called once each time a runtime became ready for a project. */
  onStarted?: (project: RuntimeProject) => void;
  /** Clock, injectable for tests. */
  now?: () => number;
}

const READY_WAIT_SLACK_MS = 5000;

const DEFAULT_RESTART: RestartPolicy = {
  baseDelayMs: 250,
  maxDelayMs: 10_000,
  maxAttempts: 5,
  resetAfterMs: 60_000,
};

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Waiters attach their own handlers; an unobserved rejection must not crash the host.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

interface Entry {
  project: RuntimeProject;
  state: RuntimeState;
  process?: RuntimeProcess;
  lastUsed: number;
  readySince?: number;
  inflight: number;
  /** Consecutive failed (re)starts. */
  restarts: number;
  lastError?: string;
  /** Settles when the runtime is ready (resolve) or was given up (reject). */
  ready: Deferred;
  /** The running start/restart procedure; never rejects. */
  task: Promise<void>;
  stopped?: Promise<void>;
  healthTimer?: NodeJS.Timeout;
  healthFailures: number;
  /** Wakes a backoff sleep when the entry is being stopped. */
  wake?: () => void;
}

interface FailureRecord {
  at: number;
  error: string;
  restarts: number;
}

function sleep(ms: number, entry: Entry): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      entry.wake = undefined;
      resolve();
    }
    entry.wake = done;
  });
}

function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

export class ProjectRuntimeManager {
  private readonly entries = new Map<string, Entry>();
  private readonly failures = new Map<string, FailureRecord>();
  private readonly options: ProjectRuntimeManagerOptions;
  private readonly restartPolicy: RestartPolicy;
  private readonly now: () => number;
  private sweepTimer: NodeJS.Timeout | undefined;
  private closed = false;
  /** Serializes the creation of entries so the limit check cannot race. */
  private creation: Promise<unknown> = Promise.resolve();

  constructor(options: ProjectRuntimeManagerOptions) {
    if (!Number.isInteger(options.maxActiveProjects) || options.maxActiveProjects < 1) {
      throw new Error("maxActiveProjects must be an integer >= 1");
    }
    this.options = options;
    this.restartPolicy = { ...DEFAULT_RESTART, ...options.restart };
    this.now = options.now ?? Date.now;
    if (options.idleTimeoutMs > 0) {
      const interval =
        options.sweepIntervalMs ??
        Math.max(250, Math.min(5000, Math.floor(options.idleTimeoutMs / 4)));
      this.sweepTimer = setInterval(() => this.sweepIdle(), interval);
      this.sweepTimer.unref();
    }
  }

  /**
   * Returns a lease on the runtime of the project, starting it if needed. The
   * request counts as in flight until `release()`.
   */
  async acquire(project: RuntimeProject): Promise<RuntimeLease> {
    for (;;) {
      if (this.closed) {
        throw runtimeStartFailed(project.id, "the host is shutting down");
      }
      const existing = this.entries.get(project.id);
      if (!existing) {
        // Wait on the entry this call created: it may already have failed and
        // been forgotten by the time we look again, which must not restart it.
        const created = await this.create(project);
        if (created) {
          await this.awaitReady(created);
        }
        continue;
      }
      const entry = existing;
      switch (entry.state) {
        case "ready":
          return this.lease(entry);
        case "starting":
        case "restarting":
          await this.awaitReady(entry);
          continue;
        case "stopping":
          await entry.stopped;
          continue;
      }
    }
  }

  status(): ManagerSnapshot {
    const runtimes: RuntimeSnapshot[] = [];
    for (const entry of this.entries.values()) {
      runtimes.push({
        projectId: entry.project.id,
        state: entry.state,
        lastUsedAt: new Date(entry.lastUsed).toISOString(),
        inflight: entry.inflight,
        restarts: entry.restarts,
        ...(entry.process?.pid !== undefined ? { pid: entry.process.pid } : {}),
        ...(entry.process ? { address: entry.process.address } : {}),
        ...(entry.lastError ? { lastError: entry.lastError } : {}),
      });
    }
    for (const [projectId, failure] of this.failures) {
      if (!this.entries.has(projectId)) {
        runtimes.push({
          projectId,
          state: "failed",
          lastUsedAt: new Date(failure.at).toISOString(),
          inflight: 0,
          restarts: failure.restarts,
          lastError: failure.error,
        });
      }
    }
    return {
      limit: this.options.maxActiveProjects,
      active: [...this.entries.values()].filter((e) => e.state !== "stopping")
        .length,
      runtimes,
    };
  }

  /** Stops the runtime of one project, if any. */
  async stopProject(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    if (entry) {
      await this.stopEntry(entry, "requested");
    }
  }

  /** Stops every runtime and waits until all processes are gone. */
  async stopAll(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    await this.creation.catch(() => undefined);
    await Promise.all(
      [...this.entries.values()].map((entry) => this.stopEntry(entry, "host shutdown")),
    );
  }

  /**
   * Reads the entry's state fresh. Other code changes it across awaits, which
   * the compiler's narrowing of a plain property read cannot see.
   */
  private isState(entry: Entry, state: RuntimeState): boolean {
    return entry.state === state;
  }

  // ── creation and limit ─────────────────────────────────────────────

  /** Returns the entry it created, or undefined when someone else already did. */
  private create(project: RuntimeProject): Promise<Entry | undefined> {
    const run = this.creation.then(() => this.createLocked(project));
    this.creation = run.catch(() => undefined);
    return run;
  }

  private async createLocked(project: RuntimeProject): Promise<Entry | undefined> {
    if (this.closed || this.entries.has(project.id)) {
      return undefined;
    }
    while (this.entries.size >= this.options.maxActiveProjects) {
      const victim = this.leastRecentlyUsedIdle();
      if (!victim) {
        throw runtimeLimitReached(this.options.maxActiveProjects);
      }
      this.options.logger.info("Evicting idle project runtime to make room", {
        evictedProjectId: victim.project.id,
        forProjectId: project.id,
        limit: this.options.maxActiveProjects,
      });
      await this.stopEntry(victim, "evicted");
    }
    this.failures.delete(project.id);
    const entry: Entry = {
      project,
      state: "starting",
      lastUsed: this.now(),
      inflight: 0,
      restarts: 0,
      ready: deferred(),
      task: Promise.resolve(),
      healthFailures: 0,
    };
    this.entries.set(project.id, entry);
    entry.task = this.bringUp(entry);
    return entry;
  }

  private leastRecentlyUsedIdle(): Entry | undefined {
    let victim: Entry | undefined;
    for (const entry of this.entries.values()) {
      if (!this.isState(entry, "ready") || entry.inflight > 0) {
        continue;
      }
      if (!victim || entry.lastUsed < victim.lastUsed) {
        victim = entry;
      }
    }
    return victim;
  }

  // ── leases ─────────────────────────────────────────────────────────

  private lease(entry: Entry): RuntimeLease {
    const runtime = entry.process;
    if (!runtime) {
      throw runtimeStartFailed(entry.project.id, "the runtime has no process");
    }
    entry.inflight += 1;
    entry.lastUsed = this.now();
    let released = false;
    return {
      projectId: entry.project.id,
      address: runtime.address,
      token: runtime.token,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        entry.inflight -= 1;
        entry.lastUsed = this.now();
      },
    };
  }

  /**
   * Waits for a starting or restarting runtime. Its own start is bounded by
   * `startTimeoutMs` and reports the real cause; this timer is only a safety
   * net for a wait that would otherwise never end, so it is longer.
   */
  private async awaitReady(entry: Entry): Promise<void> {
    const limitMs = this.options.startTimeoutMs + READY_WAIT_SLACK_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            runtimeStartFailed(
              entry.project.id,
              `the runtime was not ready within ${limitMs} ms`,
            ),
          ),
        limitMs,
      );
    });
    try {
      await Promise.race([entry.ready.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── start / restart ────────────────────────────────────────────────

  /** Initial start: a failure is reported to the callers and is not retried. */
  private async bringUp(entry: Entry): Promise<void> {
    try {
      await this.startOnce(entry);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      await this.giveUp(entry, cause);
      return;
    }
    if (this.isState(entry, "starting")) {
      this.markReady(entry);
    }
  }

  /** Restart after a crash: retried with backoff until the policy is exhausted. */
  private async recover(entry: Entry, reason: string): Promise<void> {
    const policy = this.restartPolicy;
    entry.lastError = reason;
    if (
      entry.readySince !== undefined &&
      this.now() - entry.readySince >= policy.resetAfterMs
    ) {
      entry.restarts = 0;
    }
    entry.readySince = undefined;
    entry.ready = deferred();
    entry.state = "restarting";

    for (;;) {
      entry.restarts += 1;
      if (entry.restarts > policy.maxAttempts) {
        await this.giveUp(entry, `gave up after ${policy.maxAttempts} restarts: ${entry.lastError}`);
        return;
      }
      const delay = Math.min(
        policy.baseDelayMs * 2 ** (entry.restarts - 1),
        policy.maxDelayMs,
      );
      this.options.logger.warn("Project runtime stopped unexpectedly; restarting", {
        projectId: entry.project.id,
        attempt: entry.restarts,
        delayMs: delay,
        reason: entry.lastError,
      });
      await sleep(delay, entry);
      if (!this.isState(entry, "restarting")) {
        return;
      }
      try {
        await this.startOnce(entry);
      } catch (error) {
        entry.lastError = error instanceof Error ? error.message : String(error);
        if (!this.isState(entry, "restarting")) {
          return;
        }
        continue;
      }
      if (this.isState(entry, "restarting")) {
        this.markReady(entry);
      }
      return;
    }
  }

  /**
   * Launches the process and waits for it to become healthy. Throws with the
   * cause when it exits first or times out; the process is stopped then.
   * Returns early (without throwing) when the entry is being stopped.
   */
  private async startOnce(entry: Entry): Promise<void> {
    const project = entry.project;
    const runtime = await this.options.launcher.launch(project);
    entry.process = runtime;
    if (this.isState(entry, "stopping")) {
      return;
    }
    void runtime.exited.then((exit) => this.onExit(entry, runtime, exit));

    const deadline = this.now() + this.options.startTimeoutMs;
    const pollMs = this.options.startPollMs ?? 50;
    let exit: RuntimeExit | undefined;
    void runtime.exited.then((value) => {
      exit = value;
    });
    for (;;) {
      if (this.isState(entry, "stopping")) {
        return;
      }
      if (exit) {
        throw new Error(
          `the runtime exited (code ${exit.code ?? "none"}, signal ${exit.signal ?? "none"}) before it was ready${this.tail(runtime)}`,
        );
      }
      if (await this.options.launcher.probe(runtime).catch(() => false)) {
        return;
      }
      if (this.now() >= deadline) {
        await runtime.stop().catch(() => undefined);
        throw new Error(
          `the runtime was not healthy within ${this.options.startTimeoutMs} ms${this.tail(runtime)}`,
        );
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, pollMs);
      });
    }
  }

  private tail(runtime: RuntimeProcess): string {
    const output = oneLine(runtime.outputTail());
    return output ? `; output: ${output}` : "";
  }

  private markReady(entry: Entry): void {
    entry.state = "ready";
    entry.readySince = this.now();
    entry.healthFailures = 0;
    entry.lastError = undefined;
    this.startHealthMonitor(entry);
    entry.ready.resolve();
    this.options.logger.info("Project runtime ready", {
      projectId: entry.project.id,
      pid: entry.process?.pid,
    });
    this.options.onStarted?.(entry.project);
  }

  /** The runtime could not be started or kept running: forget it and fail its waiters. */
  private async giveUp(entry: Entry, cause: string): Promise<void> {
    this.options.logger.error(
      "Project runtime could not be started",
      undefined,
      { projectId: entry.project.id, cause },
    );
    this.failures.set(entry.project.id, {
      at: this.now(),
      error: cause,
      restarts: entry.restarts,
    });
    this.clearHealthMonitor(entry);
    const runtime = entry.process;
    entry.state = "stopping";
    // A concurrent stopAll() waits on this: no process may outlive it.
    entry.stopped = (async () => {
      await runtime?.stop().catch(() => undefined);
      entry.process = undefined;
      if (this.entries.get(entry.project.id) === entry) {
        this.entries.delete(entry.project.id);
      }
    })();
    await entry.stopped;
    entry.ready.reject(runtimeStartFailed(entry.project.id, cause));
  }

  private onExit(entry: Entry, runtime: RuntimeProcess, exit: RuntimeExit): void {
    if (entry.process !== runtime) {
      return;
    }
    this.clearHealthMonitor(entry);
    if (!this.isState(entry, "ready")) {
      // starting/restarting: the start procedure observes the exit itself;
      // stopping: the stop procedure is waiting for it.
      return;
    }
    if (this.closed) {
      return;
    }
    const reason = `exited (code ${exit.code ?? "none"}, signal ${exit.signal ?? "none"})${this.tail(runtime)}`;
    entry.task = this.recover(entry, reason);
  }

  // ── health and idle ────────────────────────────────────────────────

  private startHealthMonitor(entry: Entry): void {
    const interval = this.options.healthIntervalMs ?? 5000;
    const threshold = this.options.healthFailureThreshold ?? 3;
    const runtime = entry.process;
    if (!runtime) {
      return;
    }
    entry.healthTimer = setInterval(() => {
      void (async () => {
        if (!this.isState(entry, "ready") || entry.process !== runtime) {
          return;
        }
        const healthy = await this.options.launcher
          .probe(runtime)
          .catch(() => false);
        if (!this.isState(entry, "ready") || entry.process !== runtime) {
          return;
        }
        if (healthy) {
          entry.healthFailures = 0;
          return;
        }
        entry.healthFailures += 1;
        if (entry.healthFailures >= threshold) {
          this.options.logger.warn("Project runtime failed its health checks; killing it", {
            projectId: entry.project.id,
            failures: entry.healthFailures,
          });
          // The exit handler takes it from here and restarts it.
          await runtime.stop().catch(() => undefined);
        }
      })();
    }, interval);
    entry.healthTimer.unref();
  }

  private clearHealthMonitor(entry: Entry): void {
    if (entry.healthTimer) {
      clearInterval(entry.healthTimer);
      entry.healthTimer = undefined;
    }
  }

  private sweepIdle(): void {
    const cutoff = this.now() - this.options.idleTimeoutMs;
    for (const entry of [...this.entries.values()]) {
      if (this.isState(entry, "ready") && entry.inflight === 0 && entry.lastUsed <= cutoff) {
        void this.stopEntry(entry, "idle");
      }
    }
  }

  // ── stop ───────────────────────────────────────────────────────────

  private stopEntry(entry: Entry, reason: string): Promise<void> {
    if (entry.stopped) {
      return entry.stopped;
    }
    this.options.logger.info("Stopping project runtime", {
      projectId: entry.project.id,
      reason,
      inflight: entry.inflight,
    });
    entry.state = "stopping";
    this.clearHealthMonitor(entry);
    entry.wake?.();
    entry.stopped = (async () => {
      try {
        // Let a start/restart in progress notice the state change first.
        await entry.task;
        await entry.process?.stop();
      } catch (error) {
        this.options.logger.warn("Stopping a project runtime failed", {
          projectId: entry.project.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (this.entries.get(entry.project.id) === entry) {
          this.entries.delete(entry.project.id);
        }
        entry.ready.reject(runtimeStartFailed(entry.project.id, `stopped (${reason})`));
      }
    })();
    return entry.stopped;
  }
}
