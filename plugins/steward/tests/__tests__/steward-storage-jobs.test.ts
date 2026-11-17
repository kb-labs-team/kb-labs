import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginContextV3 } from '@kb-labs/sdk';

vi.mock('../../src/core/index.js', () => ({
  getDailyReview: vi.fn(),
  exportSnapshot: vi.fn(),
  recordExportCompleted: vi.fn(),
}));

import { exportSnapshot, getDailyReview, recordExportCompleted } from '../../src/core/index.js';
import dailyReview from '../../src/jobs/daily-review.js';
import exportBackup from '../../src/jobs/export-backup.js';

const review = vi.mocked(getDailyReview);
const snapshot = vi.mocked(exportSnapshot);
const recordExport = vi.mocked(recordExportCompleted);

type Store = {
  read: (key: string) => Promise<Buffer | null>;
  write: (key: string, value: Buffer) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: (prefix: string) => Promise<string[]>;
  exists: (key: string) => Promise<boolean>;
};

function makeStore(objects = new Map<string, Buffer>()): Store {
  return {
    read: async (key) => objects.get(key) ?? null,
    write: async (key, value) => { objects.set(key, Buffer.from(value)); },
    delete: async (key) => { objects.delete(key); },
    list: async (prefix) => [...objects.keys()].filter((key) => key.startsWith(prefix)).sort(),
    exists: async (key) => objects.has(key),
  };
}

function makeContext(storage: Store, requestId = 'request-301') {
  return {
    requestId,
    platform: { storage, logger: { debug: vi.fn(), error: vi.fn() } },
  } as unknown as PluginContextV3;
}

describe('Steward storage jobs', () => {
  afterEach(() => vi.clearAllMocks());

  // case: S-301.1
  it('writes a UTF-8 review object at its stable UTC-date key', async () => {
    review.mockResolvedValue({
      generatedAt: Date.UTC(2026, 10, 17), lastBackupDaysAgo: null,
      staleCommitments: [{ id: 'cmt_test', createdAt: 1, updatedAt: 1, text: 's301-marker commitment', status: 'open', staleAfterDays: 14 }],
      upcomingCommitments: [], activeProjects: [{ id: 'prj_test', createdAt: 1, updatedAt: 1, name: 's301-marker project', status: 'active' }],
    });
    const objects = new Map<string, Buffer>();
    const storage = makeStore(objects);

    await dailyReview({}, makeContext(storage));

    const bytes = await makeStore(objects).read('steward/reviews/2026-11-17.md');
    const markdown = bytes?.toString('utf8') ?? '';
    expect(markdown).toContain('last backup: never');
    expect(markdown).toContain('s301-marker commitment');
    expect(markdown).toContain('s301-marker project');
  });

  // case: S-301.2
  it('stores the complete snapshot under its stable UTC-date key and records success after the write', async () => {
    const value = { exportedAt: Date.UTC(2026, 10, 17), collections: { projects: [{ id: 'prj_test' }], resources: [], people: [], companies: [], project_members: [], commitments: [], events: [], topics: [] } };
    snapshot.mockResolvedValue(value);
    const objects = new Map<string, Buffer>();
    const storage = makeStore(objects);

    await exportBackup({}, makeContext(storage));

    expect(JSON.parse((await makeStore(objects).read('steward/exports/2026-11-17.json'))!.toString('utf8'))).toEqual(value);
    expect(recordExport).toHaveBeenCalledWith(value);
  });

});
