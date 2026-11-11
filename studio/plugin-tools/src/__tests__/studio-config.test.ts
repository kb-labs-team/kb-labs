import { describe, expect, it } from 'vitest';
import { createStudioRemoteConfig } from '../index.js';

describe('createStudioRemoteConfig', () => {
  it('resolves ESM .js imports to TypeScript source files', async () => {
    const config = await createStudioRemoteConfig({
      name: 'testPlugin',
      exposes: {},
      dts: false,
    });

    expect(config.resolve).toMatchObject({
      extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    });
  });
});
