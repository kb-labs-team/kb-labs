/**
 * POST /cycles handler
 *
 * Detect circular dependencies in monorepo.
 * Returns all circular dependency chains.
 */

import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import {
  buildDependencyGraph,
  findCircularDependencies,
} from '../../core/graph/index.js';

export type CyclesRequest = Record<string, never>; // Empty object

export type CyclesResponse = {
  cycles: string[][];
  cycleCount: number;
  hasCircular: boolean;
  affectedPackages: string[];
};

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<unknown, CyclesRequest>
  ): Promise<CyclesResponse> {
    try {
      // Build dependency graph
      const graph = buildDependencyGraph(ctx.cwd);

      // Find circular dependencies
      const cycles = findCircularDependencies(graph);

      // Get all affected packages (unique)
      const affectedPackages = Array.from(
        new Set(cycles.flat())
      );

      return {
        cycles,
        cycleCount: cycles.length,
        hasCircular: cycles.length > 0,
        affectedPackages,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
