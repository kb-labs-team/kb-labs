import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import * as nativeFs from 'node:fs/promises';
import path from 'node:path';
import { Glob, type GlobOptionsWithFileTypesFalse } from 'glob';

export type FilesystemObservation = {
  path: string;
  kind: 'content' | 'absent' | 'present' | 'listing';
  digest: string;
};

interface ObservationSession {
  values: FilesystemObservation[];
  parent?: ObservationSession;
  globRuntime: { instances: Map<string, Glob<GlobOptionsWithFileTypesFalse>>; tails: Map<string, Promise<void>> };
}

const sessions = new AsyncLocalStorage<ObservationSession>();
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
const failure = (error: unknown): string => error instanceof Error && 'code' in error
  ? `${String(error.code)}:${error.message}`
  : String(error);

function uniqueObservations(observations: readonly FilesystemObservation[]): FilesystemObservation[] {
  const unique = new Map<string, FilesystemObservation>();
  for (const observation of observations) {
    unique.set(`${observation.path}\0${observation.kind}\0${observation.digest}`, observation);
  }
  return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind) || a.digest.localeCompare(b.digest));
}

function record(filePath: string, kind: FilesystemObservation['kind'], value: string | Buffer): void {
  let session = sessions.getStore();
  if (!session) return;
  const locator = ['stat:', 'directory:', 'glob:', 'read:', 'access:', 'exists:', 'realpath:'].some((prefix) => filePath.startsWith(prefix));
  const absolute = locator ? filePath : path.resolve(filePath);
  const observation = { path: absolute, kind, digest: digest(value) };
  while (session) {
    session.values.push(observation);
    session = session.parent;
  }
}

export function readFile(filePath: string): Promise<Buffer>;
export function readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
export async function readFile(filePath: string, encoding?: BufferEncoding): Promise<Buffer | string> {
  try {
    const bytes = await nativeFs.readFile(filePath);
    record(filePath, 'content', bytes);
    return encoding ? bytes.toString(encoding) : bytes;
  } catch (error) {
    if (missing(error)) record(filePath, 'absent', '');
    else record(`read:${path.resolve(filePath)}`, 'present', failure(error));
    throw error;
  }
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await nativeFs.access(filePath);
    record(filePath, 'present', 'present');
    return true;
  } catch (error) {
    if (missing(error)) {
      record(filePath, 'absent', '');
      return false;
    }
    record(`exists:${path.resolve(filePath)}`, 'present', failure(error));
    throw error;
  }
}

export async function access(filePath: string): Promise<void> {
  try {
    await nativeFs.access(filePath);
    record(filePath, 'present', 'present');
  } catch (error) {
    if (missing(error)) record(filePath, 'absent', '');
    else record(`access:${path.resolve(filePath)}`, 'present', failure(error));
    throw error;
  }
}

export async function realpath(filePath: string): Promise<string> {
  try {
    const resolved = await nativeFs.realpath(filePath);
    record(`realpath:${path.resolve(filePath)}`, 'present', resolved);
    return resolved;
  } catch (error) {
    if (missing(error)) record(filePath, 'absent', '');
    else record(`realpath:${path.resolve(filePath)}`, 'present', failure(error));
    throw error;
  }
}

export async function stat(filePath: string): Promise<Awaited<ReturnType<typeof nativeFs.stat>>> {
  try {
    const value = await nativeFs.stat(filePath);
    record(`stat:${path.resolve(filePath)}`, 'present', JSON.stringify({ size: value.size, mode: value.mode, mtimeMs: value.mtimeMs, file: value.isFile(), directory: value.isDirectory() }));
    return value;
  } catch (error) {
    if (missing(error)) record(`stat:${path.resolve(filePath)}`, 'absent', '');
    else record(`stat:${path.resolve(filePath)}`, 'present', failure(error));
    throw error;
  }
}

export async function listDirectory(directoryPath: string): Promise<string[]> {
  try {
    const entries = await nativeFs.readdir(directoryPath);
    record(`directory:${path.resolve(directoryPath)}`, 'listing', JSON.stringify([...entries].sort()));
    return entries;
  } catch (error) {
    record(`directory:${path.resolve(directoryPath)}`, 'listing', failure(error));
    throw error;
  }
}

async function walkGlob(pattern: string | string[], options: GlobOptionsWithFileTypesFalse & { cwd: string }): Promise<string[]> {
  const runtime = sessions.getStore()?.globRuntime;
  const cacheKey = JSON.stringify({ cwd: path.resolve(options.cwd), ignore: options.ignore ?? [] });
  let values: string[];
  try {
    if (!runtime) {
      values = await new Glob(pattern, options).walk();
    } else {
      const previous = runtime.tails.get(cacheKey) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const next = new Promise<void>((resolve) => { release = resolve; });
      runtime.tails.set(cacheKey, next);
      await previous;
      try {
        const reusable = runtime.instances.get(cacheKey);
        const walker = new Glob(pattern, reusable ?? options);
        values = await walker.walk();
        runtime.instances.set(cacheKey, walker);
      } finally {
        release();
      }
    }
  } catch (error) {
    const requestPath = `glob:${JSON.stringify({ cwd: path.resolve(options.cwd), pattern, ignore: options.ignore ?? [] })}`;
    const observation = { path: requestPath, kind: 'listing' as const, digest: digest(failure(error)) };
    let session = sessions.getStore();
    while (session) {
      session.values.push(observation);
      session = session.parent;
    }
    throw error;
  }
  const requestPath = `glob:${JSON.stringify({ cwd: path.resolve(options.cwd), pattern, ignore: options.ignore ?? [] })}`;
  const observation = { path: requestPath, kind: 'listing' as const, digest: digest(JSON.stringify([...values].sort())) };
  let session = sessions.getStore();
  while (session) {
    session.values.push(observation);
    session = session.parent;
  }
  return values;
}

export async function glob(pattern: string, options: GlobOptionsWithFileTypesFalse & { cwd: string }): Promise<string[]> {
  return walkGlob(pattern, options);
}

export async function globMany(patterns: readonly string[], options: GlobOptionsWithFileTypesFalse & { cwd: string }): Promise<string[]> {
  return walkGlob([...patterns], options);
}

export async function captureFilesystemObservations<T>(run: () => Promise<T>): Promise<{ result: T; observations: FilesystemObservation[] }> {
  const parent = sessions.getStore();
  const session: ObservationSession = {
    values: [],
    parent,
    globRuntime: parent?.globRuntime ?? { instances: new Map(), tails: new Map() },
  };
  const result = await sessions.run(session, run);
  return { result, observations: uniqueObservations(session.values) };
}

export async function replayFilesystemObservationSet(observations: readonly FilesystemObservation[]): Promise<FilesystemObservation[]> {
  const currentInputs = uniqueObservations(observations);
  const values = await captureFilesystemObservations(async () => {
    const contentPaths = new Set(currentInputs.filter((observation) => observation.kind === 'content').map((observation) => observation.path));
    await Promise.all(currentInputs.map(async (observation) => {
      if (observation.kind === 'content') {
        try { await readFile(observation.path); } catch { /* the facade recorded the current read failure */ }
        return;
      } else if (observation.kind === 'present' || observation.kind === 'absent') {
        if (observation.path.startsWith('read:')) {
          try { await readFile(observation.path.slice('read:'.length)); } catch { /* the facade recorded the failed read */ }
          return;
        }
        if (observation.path.startsWith('access:')) {
          try { await access(observation.path.slice('access:'.length)); } catch { /* the facade recorded the failed access */ }
          return;
        }
        if (observation.path.startsWith('exists:')) {
          try { await exists(observation.path.slice('exists:'.length)); } catch { /* the facade recorded the failed check */ }
          return;
        }
        if (observation.path.startsWith('realpath:')) {
          try { await realpath(observation.path.slice('realpath:'.length)); } catch { /* the facade recorded the failed resolution */ }
          return;
        }
        if (contentPaths.has(observation.path) && observation.kind === 'present') {
          record(observation.path, 'present', 'present');
          return;
        }
        if (observation.path.startsWith('stat:')) {
          try { await stat(observation.path.slice('stat:'.length)); } catch { /* the facade records the current stat failure */ }
        } else {
          await exists(observation.path);
        }
      } else {
        if (observation.path.startsWith('directory:')) {
          try { await listDirectory(observation.path.slice('directory:'.length)); } catch { /* the facade recorded the failed listing */ }
        } else {
          const request = JSON.parse(observation.path.slice('glob:'.length)) as { cwd: string; pattern: string | string[]; ignore: string[] };
          try { await walkGlob(request.pattern, { cwd: request.cwd, ignore: request.ignore }); } catch { /* the facade recorded the failed glob */ }
        }
      }
    }));
  });
  return values.observations;
}

export async function replayFilesystemObservations(observations: readonly FilesystemObservation[]): Promise<string> {
  return hashFilesystemObservations(await replayFilesystemObservationSet(observations));
}

export function filesystemObservationsEqual(
  left: readonly FilesystemObservation[],
  right: readonly FilesystemObservation[],
): boolean {
  const leftValues = uniqueObservations(left);
  const rightValues = uniqueObservations(right);
  return leftValues.length === rightValues.length && leftValues.every((value, index) => {
    const expected = rightValues[index];
    return expected !== undefined
      && value.path === expected.path
      && value.kind === expected.kind
      && value.digest === expected.digest;
  });
}

export const fs = {
  access,
  stat,
  listDirectory,
  readFile,
  realpath,
  mkdir: (...args: Parameters<typeof nativeFs.mkdir>) => nativeFs.mkdir(...args),
  rename: (...args: Parameters<typeof nativeFs.rename>) => nativeFs.rename(...args),
  writeFile: (...args: Parameters<typeof nativeFs.writeFile>) => nativeFs.writeFile(...args),
};

export function hashFilesystemObservations(observations: readonly FilesystemObservation[]): string {
  const hash = createHash('sha256');
  for (const observation of uniqueObservations(observations)) hash.update(observation.path).update('\0').update(observation.kind).update('\0').update(observation.digest).update('\0');
  return hash.digest('hex');
}

export function hashDiscoveryFingerprint(requestIdentity: string, observations: readonly FilesystemObservation[]): string {
  return createHash('sha256').update(requestIdentity).update('\0').update(hashFilesystemObservations(observations)).digest('hex');
}


