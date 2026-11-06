import { createStudioRemoteConfig } from '@kb-labs/sdk/studio-build';

export default await createStudioRemoteConfig({
  name: 'releasePlugin',
  exposes: {
    './ReleasePage': './src/studio/pages/ReleasePage.tsx',
  },
});
