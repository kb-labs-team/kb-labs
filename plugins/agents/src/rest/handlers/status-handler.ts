/**
 * GET /run/:runId handler
 *
 * Returns current status of a run
 */

import { defineHandler, rethrowForRest, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import type { RunStatusResponse } from '../../contracts/index.js';
import { RunManager } from '../run-manager.js';

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<void>
  ): Promise<RunStatusResponse> {
    try {
      const { runId } = input.params as { runId: string };

      // First try to get active run from memory
      const run = RunManager.get(runId);

      if (!run) {
        // If not in memory, check cache for completed runs
        const state = await RunManager.getState(runId);

        if (!state) {
          // Return 404-like response
          return {
            runId,
            status: 'failed',
            task: '',
            startedAt: '',
            error: `Run ${runId} not found`,
          };
        }

        // Return cached state (no active orchestrator)
        return {
          runId: state.runId,
          status: state.status,
          task: state.task,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
          durationMs: state.durationMs,
          summary: state.summary,
          error: state.error,
        };
      }

      return {
        runId: run.runId,
        status: run.status,
        task: run.task,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs: run.durationMs,
        summary: run.summary,
        error: run.error,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
