/**
 * Get configured checks handler
 *
 * Returns the list of checks defined in kb.config.json release.checks
 * without running them. Used by the UI to show what will be checked.
 */

import { defineHandler, type RestInput, useConfig, rethrowForRest } from '@kb-labs/sdk';
import type { GetChecksResponse } from '../../contracts/index.js';
import type { ReleaseConfig, CustomCheckConfig } from '../../core/index.js';

export default defineHandler({
  async execute(ctx, input: RestInput<{ scope?: string }, never>): Promise<GetChecksResponse> {
    try {
      const scope = input.query?.scope ?? 'root';

      const config = await useConfig<ReleaseConfig>();
      const checks: CustomCheckConfig[] = config?.scopes?.[scope]?.checks ?? config?.checks ?? [];

      return {
        scope,
        checks: checks.map((c) => ({
          id: c.id,
          name: c.name ?? c.id,
          optional: c.optional,
        })),
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
