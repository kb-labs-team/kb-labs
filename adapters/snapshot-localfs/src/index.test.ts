import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveRuntimeStatePath } from '@kb-labs/sdk/adapters';
import { LocalFsSnapshotAdapter } from './index.js';

let tmp: string;
let kbHome: string;
let previousKbHome: string | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'kb-snapshot-'));
  kbHome = await mkdtemp(path.join(os.tmpdir(), 'kb-snapshot-home-'));
  previousKbHome = process.env.KB_HOME;
  process.env.KB_HOME = kbHome;
});

afterEach(async () => {
  if (previousKbHome === undefined) {
    delete process.env.KB_HOME;
  } else {
    process.env.KB_HOME = previousKbHome;
  }
  await rm(tmp, { recursive: true, force: true });
  await rm(kbHome, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false);
}

async function prepareWorkspace(registryDir: string): Promise<{ workspaceId: string; filePath: string }> {
  const workspaceId = 'ws_1';
  const workspaceRoot = path.join(tmp, 'demo');
  await mkdir(registryDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    path.join(registryDir, `${workspaceId}.json`),
    JSON.stringify({ workspaceId, rootPath: workspaceRoot }, null, 2),
    'utf8'
  );
  const filePath = path.join(workspaceRoot, 'hello.txt');
  await writeFile(filePath, 'v1', 'utf8');
  return { workspaceId, filePath };
}

describe('LocalFsSnapshotAdapter', () => {
  it('captures and restores workspace snapshot, keeping default state outside the project', async () => {
    const { workspaceId, filePath } = await prepareWorkspace(
      resolveRuntimeStatePath(tmp, ['runtime', 'workspace-registry'])
    );

    const snapshot = new LocalFsSnapshotAdapter({ workspace: { cwd: tmp } });
    const snap = await snapshot.capture({ workspaceId, namespace: 'demo' });

    await writeFile(filePath, 'v2', 'utf8');
    await snapshot.restore({ snapshotId: snap.snapshotId, workspaceId, overwrite: true });

    expect(await readFile(filePath, 'utf8')).toBe('v1');
    expect(await exists(resolveRuntimeStatePath(tmp, ['runtime', 'snapshots', 'demo', snap.snapshotId]))).toBe(true);
    expect(await exists(path.join(tmp, '.kb'))).toBe(false);
  });

  it('keeps explicitly configured directories relative to the project', async () => {
    const { workspaceId } = await prepareWorkspace(path.join(tmp, 'registry'));

    const snapshot = new LocalFsSnapshotAdapter({
      workspace: { cwd: tmp },
      storageDir: 'my-snapshots',
      workspaceRegistryDir: 'registry',
    });
    const snap = await snapshot.capture({ workspaceId, namespace: 'demo' });

    expect(await exists(path.join(tmp, 'my-snapshots', 'demo', snap.snapshotId))).toBe(true);
    expect(await exists(resolveRuntimeStatePath(tmp, ['runtime', 'snapshots']))).toBe(false);
  });
});
