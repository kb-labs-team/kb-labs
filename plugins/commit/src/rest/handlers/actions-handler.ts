import { defineHandler, type PluginContextV3, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import type { ActionsResponse } from '../../contracts/index.js';

/**
 * GET /actions handler
 *
 * Returns minimal data for actions widget (widget mainly displays action buttons).
 * Returns currently selected scope for context.
 */
export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<{ scope?: string }>): Promise<ActionsResponse> {
    try {
      const scope = input.query?.scope;

      return {
        scope,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
