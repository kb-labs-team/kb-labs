import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface ProcessRecord {
  pid: number;
  ppid: number;
  startIdentity?: string;
}

export interface ProcessTableSource {
  read(): ProcessRecord[];
}

export type ProcessTreeResult =
  | { verified: true; descendants: number[] }
  | { verified: false; descendants: number[]; reason: 'enumeration-failed' | 'identity-unverified' | 'survivor-timeout' | 'termination-failed'; error?: string };

const PROCESS_TREE_TIMEOUT_MS = 1500;
const PROCESS_POLL_INTERVAL_MS = 25;

export function parseDarwinProcessTable(table: string): ProcessRecord[] {
  return table.split(/\r?\n/).flatMap(line => {
    if (!line.trim()) {return [];}
    const fields = line.trim().split(/\s+/);
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const startIdentity = fields.slice(2).join(' ');
    if (fields.length < 3 || !Number.isInteger(pid) || !Number.isInteger(ppid) || !startIdentity) {
      throw new Error('Darwin process table returned a malformed process identity record');
    }
    return [{ pid, ppid, startIdentity }];
  });
}

export const systemProcessTable: ProcessTableSource = {
  read(): ProcessRecord[] {
    if (process.platform === 'linux') {
      return readdirSync('/proc', { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
        .flatMap(entry => {
          const pid = Number(entry.name);
          const stat = readFileSync(`/proc/${entry.name}/stat`, 'utf8');
          const close = stat.lastIndexOf(')');
          const fields = stat.slice(close + 2).trim().split(/\s+/);
          const ppid = Number(fields[1]);
          if (fields[0] === 'Z' || fields[0] === 'X') {return [];}
          const startIdentity = fields[19];
          if (!Number.isInteger(ppid) || !startIdentity) {
            throw new Error(`Invalid process identity record for PID ${pid}`);
          }
          return [{ pid, ppid, startIdentity }];
        });
    }
    if (process.platform === 'darwin') {
      const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { encoding: 'utf8' });
      return parseDarwinProcessTable(table);
    }
    throw new Error(`Process-tree inspection is unsupported on ${process.platform}`);
  },
};

function descendantsOf(rootPid: number, table: ProcessRecord[]): ProcessRecord[] {
  const children = new Map<number, ProcessRecord[]>();
  for (const record of table) {
    const list = children.get(record.ppid) ?? [];
    list.push(record);
    children.set(record.ppid, list);
  }
  const levels: ProcessRecord[][] = [];
  let frontier = children.get(rootPid) ?? [];
  while (frontier.length) {
    levels.push(frontier);
    frontier = frontier.flatMap(record => children.get(record.pid) ?? []);
  }
  return levels.reverse().flat();
}

function sameProcess(expected: ProcessRecord, current: ProcessRecord | undefined): boolean {
  return expected.startIdentity !== undefined
    && current?.startIdentity !== undefined
    && expected.startIdentity === current.startIdentity
    && expected.ppid === current.ppid;
}

function identityUnverified(expected: ProcessRecord, current: ProcessRecord | undefined): boolean {
  return current !== undefined && !sameProcess(expected, current);
}

function signalProcess(pid: number): string | undefined {
  try { process.kill(pid, 'SIGKILL'); return undefined; }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {return undefined;}
    return error instanceof Error ? error.message : String(error);
  }
}

export async function terminateProcessTree(
  rootPid: number,
  source: ProcessTableSource = systemProcessTable,
  timeoutMs = PROCESS_TREE_TIMEOUT_MS,
): Promise<ProcessTreeResult> {
  let descendants: ProcessRecord[];
  try {
    descendants = descendantsOf(rootPid, source.read());
  } catch (error) {
    const rootKillError = signalProcess(rootPid);
    return { verified: false, descendants: [], reason: 'enumeration-failed', error: [error instanceof Error ? error.message : String(error), rootKillError].filter(Boolean).join('; ') };
  }

  let beforeTermination: ProcessRecord[];
  try {
    beforeTermination = source.read();
  } catch (error) {
    const rootKillError = signalProcess(rootPid);
    return { verified: false, descendants: descendants.map(record => record.pid), reason: 'enumeration-failed', error: [error instanceof Error ? error.message : String(error), rootKillError].filter(Boolean).join('; ') };
  }
  const currentByPid = new Map(beforeTermination.map(record => [record.pid, record]));
  const uncertain = descendants.filter(record => identityUnverified(record, currentByPid.get(record.pid)));
  const verified = descendants.filter(record => sameProcess(record, currentByPid.get(record.pid)));
  const signalErrors = verified.flatMap(record => {
    const error = signalProcess(record.pid);
    return error ? [`${record.pid}: ${error}`] : [];
  });
  const rootKillError = signalProcess(rootPid);
  if (rootKillError || signalErrors.length) {
    return { verified: false, descendants: descendants.map(record => record.pid), reason: 'termination-failed', error: [rootKillError, ...signalErrors].filter(Boolean).join('; ') };
  }
  if (uncertain.length) {
    return { verified: false, descendants: uncertain.map(record => record.pid), reason: 'identity-unverified' };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let current: ProcessRecord[];
    try { current = source.read(); }
    catch (error) {
      return { verified: false, descendants: descendants.map(record => record.pid), reason: 'enumeration-failed', error: error instanceof Error ? error.message : String(error) };
    }
    const byPid = new Map(current.map(record => [record.pid, record]));
    const uncertain = descendants.filter(record => identityUnverified(record, byPid.get(record.pid)));
    if (uncertain.length) {
      return { verified: false, descendants: uncertain.map(record => record.pid), reason: 'identity-unverified' };
    }
    if (!descendants.some(record => sameProcess(record, byPid.get(record.pid)))) {
      return { verified: true, descendants: descendants.map(record => record.pid) };
    }
    await new Promise(resolve => { setTimeout(resolve, PROCESS_POLL_INTERVAL_MS); });
  }
  return { verified: false, descendants: descendants.map(record => record.pid), reason: 'survivor-timeout' };
}
