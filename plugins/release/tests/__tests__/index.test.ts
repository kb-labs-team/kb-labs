import { describe, it, expect } from 'vitest';
import * as core from '@kb-labs/release/core';

describe('@kb-labs/release/core public exports', () => {
  it('does not re-export the dead legacy publisher/runner functions', () => {
    expect((core as Record<string, unknown>).publishPackages).toBeUndefined();
    expect((core as Record<string, unknown>).generateChangelog).toBeUndefined();
    expect((core as Record<string, unknown>).generateEnhancedChangelog).toBeUndefined();
    expect((core as Record<string, unknown>).runRelease).toBeUndefined();
  });

  it('still exports the live publisher functions used by the pipeline', () => {
    expect(typeof core.copyChangelogToPackages).toBe('function');
    expect(typeof core.commitAndTagRelease).toBe('function');
    expect(typeof core.updatePackageVersions).toBe('function');
  });
});
