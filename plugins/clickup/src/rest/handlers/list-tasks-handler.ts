import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { requireApiKey, getListTasks } from '../../core/index.js';
import { rethrowForRest } from '../../utils/error.js';

type ListTasksQuery = {
  statuses?: string;
  assignees?: string;
  limit?: string;
  page?: string;
  include_closed?: string;
};

export default defineHandler({
  async execute(
    _ctx: PluginContextV3,
    input: RestInput<ListTasksQuery, never, { listId: string }>,
  ) {
    try {
      const apiKey = requireApiKey();
      const listId = input.params?.listId;
      if (!listId) throw new Error('listId is required');
      const q = input.query ?? {};

      return getListTasks(apiKey, listId, {
        statuses: q.statuses ? q.statuses.split(',') : undefined,
        assignees: q.assignees ? q.assignees.split(',') : undefined,
        limit: q.limit ? Math.min(Number(q.limit), 100) : 50,
        page: q.page ? Number(q.page) : 0,
        include_closed: q.include_closed === 'true',
      });
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
