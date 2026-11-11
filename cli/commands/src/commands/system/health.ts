import type { SystemHealthSnapshot } from '@kb-labs/plugin-contracts';
import { getResolvedCatalog } from '../../registry/discovery-state.js';
import { generateExamples } from '../../utils/generate-examples';
import {
  defineSystemCommand,
  throwSystemCommandError,
} from '@kb-labs/shared-command-kit';

type HealthFlags = {
  json: { type: 'boolean'; description?: string };
};

type HealthSnapshot = SystemHealthSnapshot;
type HealthResult = SystemHealthSnapshot;

export const health = defineSystemCommand<HealthFlags, HealthResult>({
  name: 'health',
  scope: 'platform',
  authProtection: 'public',
  jsonTest: { safeArgs: [] },
  description: 'Report overall CLI health snapshot',
  longDescription: 'Shows the kb.health/1 snapshot shared with REST and Studio.',
  category: 'info',
  // Also accessible as `kb health` (short form without group prefix)
  aliases: ['health'],
  examples: generateExamples('health', 'kb', [
    { flags: {} },
    { flags: { json: true } },
  ]),
  flags: {
    json: { type: 'boolean', description: 'Output in JSON format' },
  },
  analytics: {
    command: 'health',
    startEvent: 'HEALTH_STARTED',
    finishEvent: 'HEALTH_FINISHED',
  },
  async handler(ctx, _argv, _flags) {
    const cliApi = getResolvedCatalog();
    if (!cliApi) {throw new Error('The CLI catalog was not opened during command registration.');}

    try {
      ctx.platform?.logger?.info('Health check started');

      const snapshot = await cliApi.getSystemHealth({
        uptimeSec: process.uptime(),
        version: { rest: 'n/a' },
        meta: { source: 'cli' },
      });

      ctx.platform?.logger?.info('Health check completed', { status: snapshot.status });

      return snapshot as HealthSnapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throwSystemCommandError(message, "Run `kb info health --help` to review valid inputs and recovery steps, then retry.");
    }
  },

  formatter(result, ctx) {
    const snapshot = result;
    const gitInfo = snapshot.version.git
      ? `${snapshot.version.git.sha}${snapshot.version.git.dirty ? ' (dirty)' : ''}`
      : 'n/a';

    const sections = [
      {
        header: 'Status',
        items: [
          `Status: ${result.status}`,
          `KB Labs: ${snapshot.version.kbLabs}`,
          `CLI: ${snapshot.version.kbLabs}`,
          `REST: ${snapshot.version.rest}`,
          `Git: ${gitInfo}`,
        ],
      },
      {
        header: 'Registry',
        items: [
          `Plugins: ${snapshot.registry.total} total (rest ${snapshot.registry.withRest}, studio ${snapshot.registry.withStudio})`,
          `Errors: ${snapshot.registry.errors}`,
          `Generated: ${snapshot.registry.generatedAt}`,
          `Expires: ${snapshot.registry.expiresAt ?? 'n/a'}`,
          `Partial: ${snapshot.registry.partial ? 'yes' : 'no'}`,
          `Stale: ${snapshot.registry.stale ? 'yes' : 'no'}`,
        ],
      },
      ...(snapshot.components.filter(component => component.id === 'execution').map(component => ({
        header: 'Execution',
        items: [
          `Health: ${component.status ?? 'unknown'}`,
          `Workers: ${formatWorkers(component.details?.workers)}`,
          `Mode: ${String(component.details?.executionMode ?? 'unknown')}`,
          `Last failure: ${formatFailure(component.details?.lastStartFailure)}`,
        ],
      }))),
      {
        header: 'System',
        items: [`Uptime: ${snapshot.uptimeSec}s`],
      },
    ];

    if (result.status === 'healthy') {
      ctx.ui.success('System Health', { sections });
    } else {
      ctx.ui.warn('System Health', { sections });
    }
  },
});

function formatWorkers(value: unknown): string {
  if (!value || typeof value !== 'object') {return 'n/a';}
  const workers = value as Record<string, unknown>;
  return `total ${String(workers.total ?? 0)}, idle ${String(workers.idle ?? 0)}, busy ${String(workers.busy ?? 0)}, queued ${String(workers.queued ?? 0)}, queue limit ${String(workers.queueLimit ?? 0)}`;
}

function formatFailure(value: unknown): string {
  if (!value || typeof value !== 'object') {return 'none';}
  const failure = value as Record<string, unknown>;
  return `${String(failure.code ?? 'unknown')} at ${String(failure.at ?? 'unknown time')}`;
}
