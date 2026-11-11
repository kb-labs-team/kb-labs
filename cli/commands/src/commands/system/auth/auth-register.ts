/**
 * kb auth register — Register a new service account with Gateway.
 *
 * Calls POST /auth/register to create clientId + clientSecret.
 * These are printed to stdout and should be saved securely.
 *
 * Not self-service: /auth/register requires the caller to already be
 * authenticated as an admin with MACHINE_REGISTER (see
 * services/gateway/auth/README.md). This command prefers a stored human
 * session (~/.kb/session.json, set by "kb auth login --email/--password")
 * as its Bearer token — that's the identity that actually carries
 * MACHINE_REGISTER (see services/gateway/auth/src/stub-pdp.ts). It falls
 * back to stored machine credentials (~/.kb/credentials.json, set by
 * "kb auth login --client-id/--client-secret") only when no session exists,
 * for callers whose machine token happens to carry the permission. Log in
 * as the bootstrap admin first (printed once by `kb-create`, or in .env /
 * GATEWAY_BOOTSTRAP_ADMIN_PASSWORD).
 */

import { defineSystemCommand, throwSystemCataloguedError, throwSystemCommandError, type CommandResult } from '@kb-labs/shared-command-kit';
import { gatewayApiFetch, readGatewaySuccessData } from '@kb-labs/sdk/gateway';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import { ErrorEnvelopeError } from '@kb-labs/core-platform';

type RegisterFlags = {
  'gateway-url': { type: 'string'; description: string };
  name: { type: 'string'; description: string };
  'namespace-id': { type: 'string'; description: string };
  json: { type: 'boolean'; description: string };
};

type RegisterResult = CommandResult & {
  clientId?: string;
  clientSecret?: string;
  hostId?: string;
};

/** Sends the same {ok:false, error} shape whether --json is set or not, and returns it. */
function fail(_ctx: PluginContextV3, _json: boolean | undefined, msg: string): RegisterResult {
  throwSystemCommandError(msg, "Run `kb auth register --help` to review valid inputs and recovery steps, then retry.");
}

export const authRegister = defineSystemCommand<RegisterFlags, RegisterResult>({
  name: 'register',
  scope: 'platform',
  authProtection: 'public',
  jsonTest: { noSafeValidPath: "This command creates an authentication account." },
  description: 'Register a new service account with Gateway',
  longDescription:
    'Creates a new client registration in Gateway and returns clientId + clientSecret. ' +
    'Use these credentials with "kb auth login" to authenticate.',
  category: 'auth',
  examples: [
    'kb auth register --gateway-url <gateway-url> --name my-cli --namespace-id default',
    'kb auth register --gateway-url <gateway-url> --name ci-agent --namespace-id default --json',
  ],
  flags: {
    'gateway-url': { type: 'string', description: 'Gateway server URL' },
    name: { type: 'string', description: 'Service account name (1-64 chars)' },
    'namespace-id': { type: 'string', description: 'Namespace ID (1-64 chars)' },
    json: { type: 'boolean', description: 'Output in JSON format' },
  },
  async handler(ctx, _argv, flags) {
    const gatewayUrl = flags['gateway-url'];
    const name = flags.name;
    const namespaceId = flags['namespace-id'];

    if (!gatewayUrl || !name || !namespaceId) {
      return fail(ctx, flags.json, 'All flags required: --gateway-url, --name, --namespace-id');
    }

    let response: Response;
    try {
      response = await gatewayApiFetch(`${gatewayUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, namespaceId }),
      }, { gatewayUrl });
    } catch (err) {
      if (err instanceof ErrorEnvelopeError) { throwSystemCataloguedError(err.envelope); }
      return fail(ctx, flags.json, `Cannot reach Gateway at ${gatewayUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const data = await readGatewaySuccessData<{
      clientId: string;
      clientSecret: string;
      hostId: string;
    }>(response, { operation: 'Gateway registration', gatewayUrl });

    if (!flags.json) {
      ctx.ui?.write?.('Service account created successfully.\n\n');
      ctx.ui?.write?.(`  Client ID:     ${data.clientId}\n`);
      ctx.ui?.write?.(`  Client Secret: ${data.clientSecret}\n`);
      ctx.ui?.write?.(`  Host ID:       ${data.hostId}\n\n`);
      ctx.ui?.write?.('Save these credentials securely — the secret is shown only once.\n\n');
      ctx.ui?.write?.('To authenticate:\n');
      ctx.ui?.write?.(`  kb auth login --gateway-url ${gatewayUrl} --client-id ${data.clientId} --client-secret ${data.clientSecret}\n`);
    }

    return {  clientId: data.clientId, clientSecret: data.clientSecret, hostId: data.hostId };
  },
});
