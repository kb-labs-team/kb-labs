import { WebhookHistoryRecordSchema, type WebhookHistoryRecord } from '@kb-labs/gateway-contracts';
import { ErrorEnvelopeError } from '@kb-labs/core-platform';
import { defineSystemCommand, throwSystemCataloguedError, throwSystemCommandError, type CommandResult } from '@kb-labs/shared-command-kit';
import { gatewayApiFetch, readGatewaySuccessData } from '@kb-labs/sdk/gateway';
import { resolveActiveGateway } from '@kb-labs/cli-runtime/gateway';
import { getContextCwd } from '@kb-labs/shared-cli-ui';

type HistoryFlags = { json: { type: 'boolean'; description: string } };
type HistoryResult = CommandResult & { record?: WebhookHistoryRecord };

export const webhookHistory = defineSystemCommand<HistoryFlags, HistoryResult>({
  name: 'history',
  scope: 'platform',
  jsonTest: { safeArgs: ['fixture-webhook-id'] },
  description: 'Inspect a webhook delivery history record',
  longDescription: 'Reads the durable, payload-free history record for one webhook delivery.',
  category: 'webhook',
  examples: [
    'kb webhook history <webhookId>',
    'kb webhook history <webhookId> --json',
  ],
  flags: {
    json: { type: 'boolean', description: 'Output in JSON format' },
  },
  async handler(ctx, argv, flags) {
    const webhookId = argv[0];
    if (!webhookId) {
      throwSystemCommandError('Webhook ID is required.', 'Run `kb webhook history --help` to review valid inputs, then retry.');
    }

    const target = await resolveActiveGateway({ cwd: getContextCwd(ctx), env: process.env });
    let response: Response;
    try {
      response = await gatewayApiFetch(
        `${target.gatewayUrl}/api/v1/webhooks/history/${encodeURIComponent(webhookId)}`,
        {},
        target,
        'machine',
      );
    } catch (err) {
      if (err instanceof ErrorEnvelopeError) {
        throwSystemCataloguedError(err.envelope);
      }
      throwSystemCommandError(
        `Cannot reach Gateway at ${target.gatewayUrl}: ${err instanceof Error ? err.message : String(err)}`,
        'Run `kb webhook history --help` to review valid inputs, then retry.',
      );
    }

    const data = await readGatewaySuccessData<{ record: unknown }>(response, {
      operation: 'Webhook history lookup', gatewayUrl: target.gatewayUrl,
    });
    const record = WebhookHistoryRecordSchema.parse(data.record);
    if (!flags.json) {
      const outcome = record.outcome.type === 'delivered'
        ? 'delivered'
        : `${record.outcome.type} (${record.outcome.code})`;
      ctx.ui?.write?.(`Webhook: ${record.webhookId}\n`);
      ctx.ui?.write?.(`Project: ${record.project}\n`);
      ctx.ui?.write?.(`Received: ${record.receivedAt}\n`);
      ctx.ui?.write?.(`Plugin: ${record.pluginId}\n`);
      ctx.ui?.write?.(`Handler: ${record.handler}\n`);
      ctx.ui?.write?.(`Outcome: ${outcome}\n`);
      ctx.ui?.write?.(`Duration: ${record.durationMs} ms\n`);
      ctx.ui?.write?.(`Correlation ID: ${record.correlationId}\n`);
    }
    return { record };
  },
});
