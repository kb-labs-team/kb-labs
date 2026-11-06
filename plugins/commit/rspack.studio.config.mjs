/**
 * Rspack config for commit plugin Studio pages (Module Federation remote).
 * Builds to dist/widgets/ alongside the main tsup build in dist/.
 *
 * Build: pnpm run build:studio
 * Dev:   pnpm run dev:studio
 */

import { createStudioRemoteConfig } from '@kb-labs/sdk/studio-build';

export default await createStudioRemoteConfig({
  name: 'commitPlugin',
  exposes: {
    './CommitOverview': './src/studio/pages/CommitOverview.tsx',
  },
});
