/**
 * GET /types handler
 *
 * TypeScript type safety analysis across monorepo
 */

import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { analyzeTypes } from '../../core/types/index.js';
import type { TypeAnalysisResult } from '../../contracts/index.js';

export type TypesRequest = {
  package?: string;
  errorsOnly?: boolean;
};

export type TypesResponse = TypeAnalysisResult;

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<TypesRequest, unknown>
  ): Promise<TypesResponse> {
    try {
      const { package: packageFilter, errorsOnly } = input.query ?? {};

      return analyzeTypes(ctx.cwd, {
        packageFilter,
        errorsOnly: errorsOnly ?? false,
      });
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
