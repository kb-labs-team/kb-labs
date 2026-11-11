import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import {
  QueryRequestSchema,
  type QueryRequest,
  type AgentResponse,
} from '../../contracts/index.js';
import { buildMind } from '../../platform';

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<unknown, QueryRequest>): Promise<AgentResponse> {
    try {
      const req = QueryRequestSchema.parse(input.body ?? {});
      const mind = await buildMind();
      return await mind.ask(req);
    } catch (err) {
      return rethrowForRest(err);
    }
  },
});
