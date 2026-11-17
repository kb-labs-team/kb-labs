import { describe, expect, it } from 'vitest';
import { manifest, manifestWithPermissions } from '../../src/manifest.js';

describe('Steward platform requirements and scheduled jobs', () => {
  // case: S-301.1
  it('requires storage and advertises object storage keys rather than project artifact paths', () => {
    expect(manifest.platform.requires).toContain('storage');
    expect(manifest.platform.requires).toContain('documentDatabase');
    expect(manifest.jobs.handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'daily-review', describe: expect.stringContaining('steward/reviews/') }),
      expect.objectContaining({ id: 'export-backup', describe: expect.stringContaining('steward/exports/') }),
    ]));
    expect('artifacts' in manifest).toBe(false);
    expect((manifestWithPermissions.permissions as { platform: { storage: { paths: string[] } } }).platform.storage.paths)
      .toEqual(['steward/']);
  });
});
