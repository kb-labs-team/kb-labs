/**
 * POST /dependencies handler
 *
 * Analyze dependencies: find duplicates, unused, missing.
 */

import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import {
  analyzeDependencies,
  type DuplicateDependency,
  type UnusedDependency,
  type MissingDependency,
} from '../../core/dependencies/index.js';

export type DependenciesRequest = Record<string, never>; // Empty object

export type DependenciesResponse = {
  duplicates: DuplicateDependency[];
  unused: UnusedDependency[];
  missing: MissingDependency[];
  totalIssues: number;
};

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<unknown, DependenciesRequest>
  ): Promise<DependenciesResponse> {
    try {
      const analysis = await analyzeDependencies(ctx.cwd);

      return {
        duplicates: analysis.duplicates,
        unused: analysis.unused,
        missing: analysis.missing,
        totalIssues:
          analysis.duplicates.length +
          analysis.unused.length +
          analysis.missing.length,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
