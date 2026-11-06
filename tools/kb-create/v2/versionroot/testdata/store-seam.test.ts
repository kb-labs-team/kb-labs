import * as fs from 'node:fs/promises';
import { it } from 'vitest';
import { createExtensionStore } from '../../../../../core/extension-store/src/store.js';
import { createFixturePackage } from '../../../../../core/extension-store/src/__tests__/fixtures.js';

it('produces a real extension store in the supplied container', async () => {
  if (!process.env.KB_HOME) { throw new Error('missing installed KB home'); }
  const fixture = await createFixturePackage({ name: 'seam-plugin', version: '1.0.0' });
  try {
    const store = createExtensionStore();
    const request = { name: 'seam-plugin', version: '1.0.0', kind: 'plugin' as const, spec: `file:${fixture}` };
    await store.resolve(request);
    await store.resolve(request);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}, 60_000);
