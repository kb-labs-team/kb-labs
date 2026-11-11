import { createStudioRemoteConfig } from '@kb-labs/sdk/studio-build';

const config = await createStudioRemoteConfig({
  name: 'packedFixture',
  exposes: { './Fixture': './src/studio/Fixture.tsx' },
});

if (!Array.isArray(config.plugins) || config.plugins.length !== 1) {
  throw new Error('Studio remote config must contain its Module Federation plugin.');
}

export default config;
