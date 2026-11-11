import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { requireApiKey, requireTeamId, searchTasks } from '../../core/index.js';
import { rethrowForRest } from '../../utils/error.js';

type SearchQuery = {
  q?: string;
  list_ids?: string;
  statuses?: string;
  assignees?: string;
  limit?: string;
  page?: string;
  include_closed?: string;
};

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<SearchQuery>) {
    try {
      const apiKey = requireApiKey();
      const teamId = requireTeamId();
      const q = input.query ?? {};

      return searchTasks(apiKey, teamId, {
        query: q.q,
        list_ids: q.list_ids ? q.list_ids.split(',') : undefined,
        statuses: q.statuses ? q.statuses.split(',') : undefined,
        assignees: q.assignees ? q.assignees.split(',') : undefined,
        limit: q.limit ? Math.min(Number(q.limit), 100) : 20,
        page: q.page ? Number(q.page) : 0,
        include_closed: q.include_closed === 'true',
      });
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
