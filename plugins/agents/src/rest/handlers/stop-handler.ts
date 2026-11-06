/**
 * POST /run/:runId/stop handler
 *
 * Stops a running agent execution
 */

import { defineHandler, rethrowForRest, useAnalytics, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import type { StopRequest, StopResponse } from '../../contracts/index.js';
import { AGENT_ANALYTICS_EVENTS } from '../../contracts/index.js';
import { RunManager } from '../run-manager.js';

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<StopRequest>
  ): Promise<StopResponse> {
    try {
      const { runId } = input.params as { runId: string };
      const body = input.body as StopRequest | undefined;
      const reason = body?.reason;

      ctx.platform.logger.info(`[stop-handler] Stop requested for run ${runId}${reason ? `: ${reason}` : ''}`);

      const run = RunManager.get(runId);

      if (!run) {
        return {
          stopped: false,
          runId,
          finalStatus: 'not_found',
        };
      }

      if (run.status === 'completed' || run.status === 'failed' || run.status === 'stopped') {
        return {
          stopped: false,
          runId,
          finalStatus: 'already_completed',
        };
      }

      // Signal the agent to stop after its current tool call finishes
      RunManager.requestStop(runId);

      // Update status optimistically — agent:end event will also update it async
      await RunManager.updateStatus(runId, 'stopped', {
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(run.startedAt).getTime(),
        summary: reason ? `Stopped by user: ${reason}` : 'Stopped by user',
      });

      // Track stop
      const analytics = useAnalytics();
      await analytics?.track(AGENT_ANALYTICS_EVENTS.RUN_STOPPED, {
        runId,
        durationMs: Date.now() - new Date(run.startedAt).getTime(),
        reason: reason?.slice(0, 200),
      });

      ctx.platform.logger.info(`[stop-handler] Run ${runId} stopped`);

      return {
        stopped: true,
        runId,
        finalStatus: 'stopped',
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
