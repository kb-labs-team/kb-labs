import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  loadCheckpoint,
  writeCheckpoint,
  updateCheckpointGitRoot,
  markCheckpointComplete,
  deleteCheckpoint,
  isCheckpointResumable,
  type ReleaseCheckpoint,
} from '../../src/core/checkpoint';

function makeRoot(): string {
  const root = join(tmpdir(), `cp-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(root, { recursive: true });
  return root;
}

const SAMPLE_CP: Omit<ReleaseCheckpoint, 'createdAt'> = {
  flow: 'platform',
  version: '2.85.0',
  publishedPackages: [
    { name: '@kb/alpha', version: '2.85.0', path: '/tmp/alpha', gitRoot: '/tmp/alpha' },
  ],
  gitRoots: {},
};

describe('checkpoint — read/write lifecycle', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns null when no checkpoint file exists', () => {
    expect(loadCheckpoint(root)).toBeNull();
  });

  it('round-trips write → load', () => {
    writeCheckpoint(root, SAMPLE_CP);
    const loaded = loadCheckpoint(root);
    expect(loaded).not.toBeNull();
    expect(loaded!.flow).toBe('platform');
    expect(loaded!.version).toBe('2.85.0');
    expect(loaded!.publishedPackages).toHaveLength(1);
    expect(loaded!.createdAt).toBeTruthy();
  });

  it('deleteCheckpoint removes the file', () => {
    writeCheckpoint(root, SAMPLE_CP);
    expect(loadCheckpoint(root)).not.toBeNull();
    deleteCheckpoint(root);
    expect(loadCheckpoint(root)).toBeNull();
  });

  it('deleteCheckpoint does not throw when file is missing', () => {
    expect(() => deleteCheckpoint(root)).not.toThrow();
  });
});

describe('checkpoint — updateCheckpointGitRoot', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('updates gitRoots entry', () => {
    writeCheckpoint(root, SAMPLE_CP);
    updateCheckpointGitRoot(root, '/tmp/alpha', { committed: true, tagged: ['v2.85.0'], pushed: true });
    const loaded = loadCheckpoint(root);
    expect(loaded!.gitRoots['/tmp/alpha']?.pushed).toBe(true);
    expect(loaded!.gitRoots['/tmp/alpha']?.tagged).toEqual(['v2.85.0']);
  });

  it('is a no-op when no checkpoint exists', () => {
    expect(() => updateCheckpointGitRoot(root, '/tmp/alpha', { committed: true, tagged: [], pushed: true })).not.toThrow();
    expect(loadCheckpoint(root)).toBeNull();
  });
});

describe('checkpoint — markCheckpointComplete', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('sets completedAt timestamp', () => {
    writeCheckpoint(root, SAMPLE_CP);
    markCheckpointComplete(root);
    const loaded = loadCheckpoint(root);
    expect(loaded!.completedAt).toBeTruthy();
  });
});

describe('isCheckpointResumable', () => {
  const base: ReleaseCheckpoint = {
    ...SAMPLE_CP,
    gitRoots: { '/tmp/alpha': { committed: true, tagged: ['v2.85.0'], pushed: false } },
    createdAt: new Date().toISOString(),
  };

  it('returns true when publish done and git not fully pushed', () => {
    expect(isCheckpointResumable(base, 'platform', '2.85.0')).toBe(true);
  });

  it('returns false when completedAt is set', () => {
    expect(isCheckpointResumable({ ...base, completedAt: new Date().toISOString() }, 'platform', '2.85.0')).toBe(false);
  });

  it('returns false when flow does not match', () => {
    expect(isCheckpointResumable(base, 'other-flow', '2.85.0')).toBe(false);
  });

  it('returns false when version does not match and not independent', () => {
    expect(isCheckpointResumable(base, 'platform', '1.0.0')).toBe(false);
  });

  it('accepts any version when version param is "independent"', () => {
    expect(isCheckpointResumable(base, 'platform', 'independent')).toBe(true);
  });

  it('returns false when no packages published', () => {
    const empty: ReleaseCheckpoint = { ...base, publishedPackages: [] };
    expect(isCheckpointResumable(empty, 'platform', '2.85.0')).toBe(false);
  });

  it('returns false when all git roots are already pushed', () => {
    const allPushed: ReleaseCheckpoint = {
      ...base,
      gitRoots: { '/tmp/alpha': { committed: true, tagged: ['v2.85.0'], pushed: true } },
    };
    expect(isCheckpointResumable(allPushed, 'platform', '2.85.0')).toBe(false);
  });
});
