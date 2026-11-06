import type { FastifyInstance } from 'fastify';
import type { ILogger } from '@kb-labs/core-platform';
import type { OperationObserver } from '@kb-labs/shared-http';
import type { WorkflowHostService } from '../host/workflow-host-service.js';
import { CronMutationRefusedError } from '../cron-discovery.js';
import { fail, ok } from './response.js';

interface CronIdParams { id: string }

export interface CronAPIOptions {
  server: FastifyInstance;
  hostService: WorkflowHostService;
  logger: ILogger;
  observability: OperationObserver;
}

export function registerCronAPI(options: CronAPIOptions): void {
  const { server, hostService, logger, observability } = options;

  server.get('/api/v1/crons', { schema: { tags: ['Cron'], summary: 'List project and plugin crons' } }, async (_request, reply) => {
    try {
      return ok(await observability.observeOperation('workflow.cron.list', () => Promise.resolve(hostService.listCron())));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list crons';
      if (message === 'Cron scheduler not available') { return fail(reply, { code: 'KB_RUNTIME_CRON_SCHEDULER_UNAVAILABLE', message: message }); }
      logger.error('Failed to list crons', error instanceof Error ? error : undefined);
      return fail(reply, { code: 'KB_RUNTIME_CRON_LIST_FAILED', message: message });
    }
  });

  for (const [action, enabled] of [['enable', true], ['disable', false]] as const) {
    server.post<{ Params: CronIdParams }>(
      `/api/v1/crons/:id/${action}`,
      { schema: { tags: ['Cron'], summary: `${action} a project cron` } },
      async (request, reply) => {
        try {
          const data = await observability.observeOperation(`workflow.cron.${action}`, () =>
            hostService.setCronEnabled(request.params.id, enabled));
          return ok(data);
        } catch (error) {
          if (error instanceof CronMutationRefusedError) { return fail(reply, { code: error.code, message: error.message }); }
          const message = error instanceof Error ? error.message : `Failed to ${action} cron`;
          if (message.startsWith('Cron not found:')) { return fail(reply, { code: 'KB_RUNTIME_CRON_NOT_FOUND', message: message }); }
          logger.error(`Failed to ${action} cron`, error instanceof Error ? error : undefined);
          return fail(reply, { code: 'KB_RUNTIME_CRON_MUTATION_FAILED', message: message });
        }
      },
    );
  }
}
