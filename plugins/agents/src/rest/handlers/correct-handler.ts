/**
 * POST /run/:runId/correct handler
 *
 * Injects user correction into running agent(s)
 */

import { defineHandler, rethrowForRest, useAnalytics, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import type { CorrectionRequest, CorrectionResponse } from '../../contracts/index.js';
import { AGENT_ANALYTICS_EVENTS } from '../../contracts/index.js';
import { RunManager } from '../run-manager.js';

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<CorrectionRequest>
  ): Promise<CorrectionResponse> {
    try {
      const { runId } = input.params as { runId: string };
      const body = input.body as CorrectionRequest | undefined;

      if (!body?.message) {
        throw new Error('Correction message is required');
      }

      ctx.platform.logger.info(`[correct-handler] Correction for run ${runId}: ${body.message.slice(0, 50)}...`);

      const run = RunManager.get(runId);

      if (!run) {
        return {
          correctionId: '',
          routedTo: [],
          reason: `Run ${runId} not found`,
          applied: false,
        };
      }

      if (run.status !== 'running') {
        return {
          correctionId: '',
          routedTo: [],
          reason: `Run ${runId} is not running (status: ${run.status})`,
          applied: false,
        };
      }

      // Inject correction into the running agent via the public IAgentRunner API
      const correctionId = `corr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      run.agent?.injectUserContext(body.message);
      const result: CorrectionResponse = {
        correctionId,
        routedTo: [run.agent?.agentId ?? runId],
        reason: 'Injected via injectUserContext',
        applied: !!run.agent,
      };

      // Track correction
      const analytics = useAnalytics();
      await analytics?.track(
        result.applied ? AGENT_ANALYTICS_EVENTS.CORRECTION_APPLIED : AGENT_ANALYTICS_EVENTS.CORRECTION_REJECTED,
        {
          runId,
          correctionId: result.correctionId,
          routedTo: result.routedTo,
          messageLength: body.message.length,
          targetAgentId: body.targetAgentId,
        }
      );

      ctx.platform.logger.info(
        `[correct-handler] Correction ${result.correctionId} routed to: ${result.routedTo.join(', ')}`
      );

      return result;
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
