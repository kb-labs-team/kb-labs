/**
 * @module @kb-labs/project-runtime-app/watchdog
 *
 * A project runtime must not outlive the host that started it. The host stops
 * runtimes itself on a normal shutdown; this covers the host being killed
 * without a chance to (SIGKILL, crash). A pipe/IPC channel would tell the
 * runtime at once, but an IPC channel makes `launchPlatform` believe it is a
 * sandbox child, so the runtime polls the host pid instead.
 */

export interface ParentWatchdogOptions {
  parentPid: number;
  intervalMs?: number;
  onParentGone: () => void;
  /** Injectable for tests. */
  isAlive?: (pid: number) => boolean;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Starts the watchdog; returns a function that stops it. */
export function watchParent(options: ParentWatchdogOptions): () => void {
  const isAlive = options.isAlive ?? isProcessAlive;
  const timer = setInterval(() => {
    if (!isAlive(options.parentPid)) {
      clearInterval(timer);
      options.onParentGone();
    }
  }, options.intervalMs ?? 2000);
  // The watchdog alone must never keep the process alive.
  timer.unref();
  return () => clearInterval(timer);
}
