import { createStudioRemoteConfig } from '@kb-labs/sdk/studio-build';

export default await createStudioRemoteConfig({
  name: 'viewerPlugin',
  exposes: { './ViewerPage': './src/studio/pages/ViewerPage.tsx' },
});
