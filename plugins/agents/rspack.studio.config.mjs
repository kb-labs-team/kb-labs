import { createStudioRemoteConfig } from '@kb-labs/sdk/studio-build';

export default await createStudioRemoteConfig({
  name: 'agentPlugin',
  exposes: {
    './AgentsPage': './src/studio/pages/AgentsPage.tsx',
  },
});
