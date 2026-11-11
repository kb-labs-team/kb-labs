/**
 * kb webhook revoke — Revoke a provisioned webhook secret.
 *
 * Calls DELETE /api/v1/webhooks/:pluginId/:event[/:instanceId].
 * After revocation, incoming deliveries with the old secret are rejected immediately.
 */

import { defineSystemCommand, throwSystemCataloguedError, throwSystemCommandError, type CommandResult } from '@kb-labs/shared-command-kit';
import { gatewayApiFetch } from '@kb-labs/sdk/gateway';
import { resolveActiveGateway } from '@kb-labs/cli-runtime/gateway';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import { ErrorEnvelopeError } from '@kb-labs/core-platform';

type RevokeFlags = {
  plugin: { type: 'string'; description: string };
  event: { type: 'string'; description: string };
  instance: { type: 'string'; description: string };
  json: { type: 'boolean'; description: string };
};

type RevokeResult = CommandResult & { revoked?: string };

export const webhookRevoke = defineSystemCommand<RevokeFlags, RevokeResult>({
  name: 'revoke',
  scope: 'platform',
  jsonTest: { noSafeValidPath: "This command revokes a webhook secret." },
  description: 'Revoke a provisioned webhook secret',
  longDescription:
    'Deletes the webhook secret for a plugin+event combination. ' +
    'Any subsequent deliveries with the old secret are immediately rejected (no grace period). ' +
    'Use "kb webhook provision" to create a new secret afterwards.',
  category: 'webhook',
  examples: [
    'kb webhook revoke --plugin @kb-labs/rollout --event alert',
    'kb webhook revoke --plugin @kb-labs/rollout --event alert --instance prod',
    'kb webhook revoke --plugin @kb-labs/rollout --event alert --json',
  ],
  flags: {
    plugin: { type: 'string', description: 'Plugin ID (e.g. @kb-labs/rollout)' },
    event: { type: 'string', description: 'Webhook event name' },
    instance: { type: 'string', description: 'Instance ID for multi-instance webhooks (optional)' },
    json: { type: 'boolean', description: 'Output in JSON format' },
  },
  async handler(ctx, _argv, flags) {
    const pluginId = flags.plugin;
    const event = flags.event;

    if (!pluginId) {
      const msg = '--plugin is required';
      throwSystemCommandError(msg, "Run `kb webhook revoke --help` to review valid inputs and recovery steps, then retry.");
    }
    if (!event) {
      const msg = '--event is required';
      throwSystemCommandError(msg, "Run `kb webhook revoke --help` to review valid inputs and recovery steps, then retry.");
    }

    // Build path: encode each segment to handle scoped package names (@org/pkg)
    const segments = [
      encodeURIComponent(pluginId),
      encodeURIComponent(event),
      ...(flags.instance ? [encodeURIComponent(flags.instance)] : []),
    ].join('/');
    const target = await resolveActiveGateway({ cwd: getContextCwd(ctx), env: process.env });
    const url = `${target.gatewayUrl}/api/v1/webhooks/${segments}`;

    let response: Response;
    try {
      response = await gatewayApiFetch(url, {
        method: 'DELETE',
      }, target, 'machine');
    } catch (err) {
      if (err instanceof ErrorEnvelopeError) { throwSystemCataloguedError(err.envelope); }
      const msg = `Cannot reach Gateway at ${target.gatewayUrl}: ${err instanceof Error ? err.message : String(err)}`;
      throwSystemCommandError(msg, "Run `kb webhook revoke --help` to review valid inputs and recovery steps, then retry.");
    }

    const label = flags.instance
      ? `${pluginId}/${event}/${flags.instance}`
      : `${pluginId}/${event}`;

    if (!flags.json) {
      ctx.ui?.write?.(`✓  Webhook revoked: ${label}\n`);
    }

    return {  revoked: label };
  },
});
