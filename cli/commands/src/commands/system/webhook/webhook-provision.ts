/**
 * kb webhook provision — Provision (or rotate) a webhook secret.
 *
 * Calls POST /api/v1/webhooks/provision and prints the URL + secret once.
 * The secret is shown only here — it cannot be recovered after this call.
 */

import { defineSystemCommand, throwSystemCataloguedError, throwSystemCommandError, type CommandResult } from '@kb-labs/shared-command-kit';
import { gatewayApiFetch, readGatewaySuccessData } from '@kb-labs/sdk/gateway';
import { resolveActiveGateway } from '@kb-labs/cli-runtime/gateway';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import { ErrorEnvelopeError } from '@kb-labs/core-platform';

type ProvisionFlags = {
  plugin: { type: 'string'; description: string };
  event: { type: 'string'; description: string };
  instance: { type: 'string'; description: string };
  json: { type: 'boolean'; description: string };
};

type ProvisionResult = CommandResult & {
  url?: string;
  rotated?: boolean;
};

export const webhookProvision = defineSystemCommand<ProvisionFlags, ProvisionResult>({
  name: 'provision',
  scope: 'platform',
  jsonTest: { noSafeValidPath: "This command creates a webhook secret." },
  description: 'Provision (or rotate) a webhook secret',
  longDescription:
    'Generates a new webhook secret for a plugin+event combination and registers it with the Gateway. ' +
    'On first call: creates the secret. On subsequent calls: rotates it (old secret valid for 24h). ' +
    'The secret is shown once — save it immediately.',
  category: 'webhook',
  examples: [
    'kb webhook provision --plugin @kb-labs/rollout --event alert',
    'kb webhook provision --plugin @kb-labs/rollout --event alert --instance prod',
    'kb webhook provision --plugin @kb-labs/rollout --event alert --json',
  ],
  flags: {
    plugin: { type: 'string', description: 'Plugin ID (e.g. @kb-labs/rollout)' },
    event: { type: 'string', description: 'Webhook event name declared in the plugin manifest' },
    instance: { type: 'string', description: 'Instance ID for multi-instance webhooks (optional)' },
    json: { type: 'boolean', description: 'Output in JSON format' },
  },
  async handler(ctx, _argv, flags) {
    const pluginId = flags.plugin;
    const event = flags.event;

    if (!pluginId) {
      const msg = '--plugin is required';
      throwSystemCommandError(msg, "Run `kb webhook provision --help` to review valid inputs and recovery steps, then retry.");
    }
    if (!event) {
      const msg = '--event is required';
      throwSystemCommandError(msg, "Run `kb webhook provision --help` to review valid inputs and recovery steps, then retry.");
    }

    const target = await resolveActiveGateway({ cwd: getContextCwd(ctx), env: process.env });
    const url = `${target.gatewayUrl}/api/v1/webhooks/provision`;
    let response: Response;
    try {
      response = await gatewayApiFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pluginId,
          event,
          ...(flags.instance ? { instanceId: flags.instance } : {}),
        }),
      }, target, 'machine');
    } catch (err) {
      if (err instanceof ErrorEnvelopeError) { throwSystemCataloguedError(err.envelope); }
      const msg = `Cannot reach Gateway at ${target.gatewayUrl}: ${err instanceof Error ? err.message : String(err)}`;
      throwSystemCommandError(msg, "Run `kb webhook provision --help` to review valid inputs and recovery steps, then retry.");
    }

    const data = await readGatewaySuccessData<{ url: string; secret: string; rotated: boolean }>(response, {
      operation: 'Webhook provisioning', gatewayUrl: target.gatewayUrl,
    });

    if (!flags.json) {
      ctx.ui?.write?.(data.rotated ? '⟳  Secret rotated (old secret valid for 24h grace period)\n' : '✓  Webhook provisioned\n');
      ctx.ui?.write?.(`URL:    ${data.url}\n`);
      ctx.ui?.write?.(`Secret: ${data.secret}\n`);
      ctx.ui?.write?.('\n⚠  Save the secret now — it will not be shown again.\n');
    }

    return {  url: data.url, secret: data.secret, rotated: data.rotated };
  },
});
