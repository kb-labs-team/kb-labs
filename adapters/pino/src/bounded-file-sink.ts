import * as nodeFs from "node:fs";

/**
 * The one declared budget of a platform process log file (x279b): the log is
 * `maxFiles` files of at most `maxFileBytes`, so total disk use never exceeds
 * `maxFiles × maxFileBytes`. The path comes from the launcher (KB_LOG_FILE).
 */
export const LOG_FILE_BUDGET = {
  maxFileBytes: 16 * 1024 * 1024,
  maxFiles: 4,
} as const;

/** The slice of node:fs the sink needs; the platform file system by default. */
export interface BoundedFileSinkFs {
  openSync(path: string, flags: "a"): number;
  fstatSync(fd: number): { size: number };
  writeSync(fd: number, data: Uint8Array): number;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { force: true }): void;
}

export interface BoundedFileSinkOptions {
  path: string;
  maxFileBytes?: number;
  maxFiles?: number;
  /** Called once per failure episode; defaults to one line on stderr. */
  report?: (message: string) => void;
  fs?: BoundedFileSinkFs;
}

/**
 * A pino destination that appends to `path`, rotates before a file would pass
 * `maxFileBytes` and keeps at most `maxFiles` files (`path`, `path.1` …).
 *
 * A failing disk (ENOSPC, EIO, quota) must never take the process down or stop
 * it serving: the first failure of an episode is reported once, records are
 * dropped while writes keep failing, and the next record retries, so logging
 * resumes by itself when the disk recovers.
 */
export class BoundedFileSink {
  private readonly path: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly report: (message: string) => void;
  private readonly fs: BoundedFileSinkFs;
  private fd: number | null = null;
  private size = 0;
  private failed = false;

  constructor(options: BoundedFileSinkOptions) {
    this.path = options.path;
    this.maxFileBytes = options.maxFileBytes ?? LOG_FILE_BUDGET.maxFileBytes;
    this.maxFiles = options.maxFiles ?? LOG_FILE_BUDGET.maxFiles;
    this.report =
      options.report ??
      ((message) => void process.stderr.write(`[kb-logs] ${message}\n`));
    this.fs = options.fs ?? nodeFs;
  }

  write(line: string): void {
    try {
      this.append(Buffer.from(line));
      this.failed = false;
    } catch (error) {
      const reasons = [describe(error)];
      try {
        this.close();
      } catch (closeError) {
        reasons.push(describe(closeError));
      }
      if (!this.failed) {
        this.failed = true;
        this.report(
          `log file ${this.path} is not writable; log records are dropped until it recovers: ${reasons.join("; ")}`,
        );
      }
    }
  }

  flush(callback?: () => void): void {
    callback?.();
  }

  /** Releases the descriptor; the next write reopens the file. */
  close(): void {
    if (this.fd === null) {
      return;
    }
    const fd = this.fd;
    this.fd = null;
    this.fs.closeSync(fd);
  }

  private append(data: Buffer): void {
    if (data.length > this.maxFileBytes) {
      throw new Error(
        `a ${data.length}-byte record exceeds the ${this.maxFileBytes}-byte file budget`,
      );
    }
    if (this.fd === null) {
      this.open();
    }
    if (this.size > 0 && this.size + data.length > this.maxFileBytes) {
      this.rotate();
    }
    let offset = 0;
    while (offset < data.length) {
      const written = this.fs.writeSync(this.fd as number, data.subarray(offset));
      offset += written;
      this.size += written;
    }
  }

  private open(): void {
    const fd = this.fs.openSync(this.path, "a");
    this.fd = fd;
    this.size = this.fs.fstatSync(fd).size;
  }

  private rotate(): void {
    this.close();
    const oldest = this.maxFiles - 1;
    if (oldest < 1) {
      this.fs.rmSync(this.path, { force: true });
    } else {
      this.fs.rmSync(`${this.path}.${oldest}`, { force: true });
      for (let index = oldest - 1; index >= 1; index -= 1) {
        this.rename(`${this.path}.${index}`, `${this.path}.${index + 1}`);
      }
      this.rename(this.path, `${this.path}.1`);
    }
    this.open();
  }

  private rename(from: string, to: string): void {
    try {
      this.fs.renameSync(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
