/**
 * Rspack config for quality plugin Studio pages (Module Federation remote).
 * Builds to dist/widgets/ alongside the main tsup build in dist/.
 *
 * Build: pnpm run build:studio
 * Dev:   pnpm run dev:studio
 */

import { createStudioRemoteConfig } from '@kb-labs/sdk/studio-build';

export default await createStudioRemoteConfig({
  name: 'qualityPlugin',
  exposes: {
    './QualityOverview': './src/studio/pages/QualityOverview.tsx',
  },
});
