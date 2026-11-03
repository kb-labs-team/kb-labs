import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDiscoverySnapshotStale } from '../discovery-inputs.js';
import { captureFilesystemObservations, exists, glob, hashFilesystemObservations, listDirectory, readFile, stat } from '../recording-filesystem.js';

describe('discovery filesystem observations', () => {
  let root: string;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
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
    const fingerprint = hashFilesystemObservations(captured.observations);
    expect(await isDiscoverySnapshotStale(captured.observations, fingerprint)).toBe(false);

    await fs.writeFile(artifact, '{"schema":"kb.plugin/3"}');
    expect(await isDiscoverySnapshotStale(captured.observations, fingerprint)).toBe(true);
  });
});
