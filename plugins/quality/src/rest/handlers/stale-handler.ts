/**
 * GET /stale handler
 *
 * Detect stale packages that need rebuilding.
 * Shows packages where source is newer than dist, or dependencies were rebuilt.
 */

import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import {
  analyzeStalePackages,
} from '../../core/stale/index.js';

export type StaleRequest = {
  detailed?: boolean;
};

export type StalePackage = {
  name: string;
  path: string;
  reason: 'source-newer' | 'dependency-rebuilt' | 'missing-dist';
  sourceModified?: string;
  distModified?: string;
  affectedPackages: string[];
  affectedCount: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
};

export type StaleChain = {
  root: string;
  affected: string[];
  depth: number;
};

export type StaleResponse = {
  stalePackages: StalePackage[];
  totalStale: number;
  totalAffected: number;
  criticalChains?: StaleChain[];
};

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<StaleRequest, unknown>
  ): Promise<StaleResponse> {
    try {
      const { detailed } = input.query ?? {};

      const analysis = await analyzeStalePackages(ctx.cwd, detailed);

      return {
        stalePackages: analysis.stalePackages,
        totalStale: analysis.totalStale,
        totalAffected: analysis.totalAffected,
        criticalChains: detailed ? analysis.criticalChains : undefined,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
