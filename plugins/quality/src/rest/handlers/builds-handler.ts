/**
 * GET /builds handler
 *
 * Get build status across monorepo packages.
 */

import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { checkBuilds } from '../../core/builds/index.js';
import type { BuildCheckResult } from '../../contracts/index.js';

export type BuildsRequest = {
  package?: string;
  timeout?: number;
};

export type BuildsResponse = BuildCheckResult;

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<BuildsRequest, unknown>
  ): Promise<BuildsResponse> {
    try {
      const { package: packageFilter, timeout } = input.query ?? {};

      return checkBuilds(ctx.cwd, {
        packageFilter,
        timeout: timeout || 30000,
      });
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
