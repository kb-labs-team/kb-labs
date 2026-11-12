import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function readStartTime(pid: number): Promise<string> {
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[19] ?? '';
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { return ''; }
      throw error;
    }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)]);
    return stdout.trim();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) {
      return '';
    }
    throw error;
  }
}

/** Compare a stored identity with a live process-table identity. */
export function sameProcessIdentity(expected: ProcessIdentity, current: ProcessIdentity | undefined): boolean {
  return current !== undefined && expected.pid === current.pid && expected.startTime === current.startTime;
}

/** OS identity for a process that may outlive its execution host. */
export interface ProcessIdentity {
  pid: number;
  startTime: string;
}

/** Runtime contract guard for identity values crossing package boundaries. */
export function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (typeof value !== 'object' || value === null) { return false; }
  const identity = value as Record<string, unknown>;
  return Number.isSafeInteger(identity.pid) && (identity.pid as number) > 0
    && typeof identity.startTime === 'string' && identity.startTime.length > 0;
}

/** Read the OS start-time token for a live process. */
export async function captureProcessIdentity(pid: number): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new RangeError(`Invalid process id: ${pid}`);
  }
  const startTime = await readStartTime(pid);
  if (!startTime) {
    throw new Error(`Process ${pid} exited before its identity could be captured`);
  }
  return { pid, startTime };
}

/** Return whether the original process still owns this PID. */
export async function isProcessIdentityAlive(identity: ProcessIdentity): Promise<boolean> {
  if (!Number.isSafeInteger(identity.pid) || identity.pid < 1) {
    throw new RangeError(`Invalid process id: ${identity.pid}`);
  }
  return sameProcessIdentity(identity, { pid: identity.pid, startTime: await readStartTime(identity.pid) });
}
