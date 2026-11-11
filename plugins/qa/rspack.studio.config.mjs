import { createStudioRemoteConfig } from '@kb-labs/sdk/studio-build';

export default await createStudioRemoteConfig({
  name: 'qaPlugin',
  exposes: {
    './QADashboard': './src/studio/pages/QADashboard.tsx',
  },
});
