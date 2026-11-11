import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDiscoverySnapshotStale } from '../discovery-inputs.js';
import { captureFilesystemObservations, exists, glob, globMany, hashDiscoveryFingerprint, listDirectory, readFile, stat } from '../recording-filesystem.js';

describe('discovery filesystem observations', () => {
  let root: string;

  afterEach(async () => {
    if (root) {await fs.rm(root, { recursive: true, force: true });}
  });

  it('records and replays content, absence, presence, and listing through one facade', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-discovery-observations-'));
    const packageFile = path.join(root, 'package.json');
    const artifact = path.join(root, 'dist', 'manifest.json');
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(packageFile, '{"name":"fixture"}');

    const captured = await captureFilesystemObservations(async () => {
      await readFile(packageFile);
      await stat(packageFile);
      await listDirectory(root);
      expect(await exists(artifact)).toBe(false);
      await glob('**/package.json', { cwd: root });
    });
    expect(captured.observations.map(({ kind }) => kind)).toEqual(expect.arrayContaining(['content', 'absent', 'present', 'listing']));
    const requestIdentity = 'test-request';
    const fingerprint = hashDiscoveryFingerprint(requestIdentity, captured.observations);
    expect(await isDiscoverySnapshotStale(captured.observations, fingerprint, requestIdentity)).toBe(false);

    await fs.writeFile(artifact, '{"schema":"kb.plugin/3"}');
    expect(await isDiscoverySnapshotStale(captured.observations, fingerprint, requestIdentity)).toBe(true);
  });

  it('stores repeated identical reads once in the content-addressed observation set', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-discovery-observations-'));
    const packageFile = path.join(root, 'package.json');
    await fs.writeFile(packageFile, '{"name":"fixture"}');

    const captured = await captureFilesystemObservations(async () => {
      await readFile(packageFile);
      await readFile(packageFile);
    });

    expect(captured.observations).toHaveLength(1);
    expect(captured.observations[0]).toMatchObject({ path: packageFile, kind: 'content' });
  });

  it('walks workspace patterns as one union listing', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-discovery-glob-union-'));
    await fs.mkdir(path.join(root, 'packages', 'alpha'), { recursive: true });
    await fs.mkdir(path.join(root, 'packages', 'beta'), { recursive: true });
    await fs.writeFile(path.join(root, 'packages', 'alpha', 'package.json'), '{}');
    await fs.writeFile(path.join(root, 'packages', 'beta', 'package.json'), '{}');

    const captured = await captureFilesystemObservations(async () =>
      globMany(['packages/*/package.json', 'packages/a*/package.json'], { cwd: root }),
    );

    expect(captured.result.sort()).toEqual(['packages/alpha/package.json', 'packages/beta/package.json']);
    expect(captured.observations.filter(({ kind }) => kind === 'listing')).toHaveLength(1);
  });
});
