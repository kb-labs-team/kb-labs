import { describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => {
  throw new Error('execa must only load when the extension installer runs');
});

describe('extension store import boundary', () => {
  // case: S-309.1
  it('does not load the process runner when importing the store package', async () => {
    const store = await import('../index.js');
    expect(store.createExtensionStore).toBeDefined();
    expect(store.PnpmInstaller).toBeDefined();
  });
});
