import { defineSystemCommand, throwSystemCataloguedError, throwSystemCommandError, type CommandResult } from '@kb-labs/shared-command-kit';
import { gatewayApiFetch, readGatewaySuccessData } from '@kb-labs/sdk/gateway';
import { resolveActiveGateway } from '@kb-labs/cli-runtime/gateway';
import type { ErrorEnvelope } from '@kb-labs/core-platform';
import { getContextCwd } from '@kb-labs/shared-cli-ui';

function errorEnvelope(error: unknown): ErrorEnvelope | null {
  if (typeof error !== 'object' || error === null || !('envelope' in error)) { return null; }
  const envelope = error.envelope;
  return typeof envelope === 'object' && envelope !== null && 'code' in envelope && 'message' in envelope
    ? envelope as ErrorEnvelope
    : null;
}

type TokenFlags = {
  name: { type: 'string'; description: string };
  revoke: { type: 'string'; description: string };
  'expires-in-days': { type: 'string'; description: string };
  json: { type: 'boolean'; description: string };
};

interface TokenRecord {
  tokenId: string;
  name: string;
  issuedAt: number;
  expiresAt?: number;
  revokedAt?: number;
}

export const authTokens = defineSystemCommand<TokenFlags, CommandResult & { tokens?: TokenRecord[]; token?: string; tokenRecord?: TokenRecord; revoked?: string }>({
  name: 'tokens',
  scope: 'platform',
  jsonTest: { noSafeValidPath: "This command exposes stored authentication tokens." },
  description: 'List, create, or revoke your API tokens',
  longDescription: 'API tokens are personal credentials for agents and CI. Each token inherits your current account permissions. Set an optional expiry from 1 to 365 days.',
  category: 'auth',
  examples: ['kb auth tokens', 'kb auth tokens --name "nightly CI"', 'kb auth tokens --name "nightly CI" --expires-in-days 90', 'kb auth tokens --revoke <token-id>'],
  flags: {
    name: { type: 'string', description: 'Create a token with this name; its secret is shown once' },
    revoke: { type: 'string', description: 'Revoke one of your tokens by token ID' },
    'expires-in-days': { type: 'string', description: 'Expire this token after 1 to 365 days (default: never)' },
    json: { type: 'boolean', description: 'Output in JSON format' },
  },
  async handler(ctx, _argv, flags) {
    const fail = (error: string) => {
      throwSystemCommandError(error, 'Run `kb auth tokens --help` to review valid inputs and recovery steps, then retry.');
    };
    let request: (path: string, method?: string, body?: Record<string, string | number>) => Promise<Response>;
    const showGatewayError = (error: unknown) => {
      const envelope = errorEnvelope(error);
      if (envelope) {
        throwSystemCataloguedError(envelope);
      }
      return fail(error instanceof Error ? error.message : String(error));
    };
    try {
      const gateway = await resolveActiveGateway({ cwd: getContextCwd(ctx), env: process.env });
      request = async (path, method = 'GET', body) => gatewayApiFetch(`${gateway.gatewayUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      }, gateway);
      if (flags.revoke) {
        const response = await request(`/auth/tokens/${encodeURIComponent(flags.revoke)}/revoke`, 'POST');
        if (!flags.json) { ctx.ui?.write?.(`Revoked API token ${flags.revoke}.\n`); }
        return {  revoked: flags.revoke };
      }
      if (flags.name) {
        const expiresFlag = flags['expires-in-days'];
        const days = expiresFlag === undefined ? undefined : Number(expiresFlag);
        if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) {
          return fail('Expiry must be a whole number from 1 to 365 days. Retry `kb auth tokens --name <name> --expires-in-days 90`.');
        }
        const response = await request('/auth/tokens', 'POST', {
          name: flags.name,
          ...(days === undefined ? {} : { expiresInDays: days }),
        });
        const result = await readGatewaySuccessData<{ token: string; tokenRecord: TokenRecord }>(response, {
          operation: 'API token creation', gatewayUrl: gateway.gatewayUrl,
        });
        if (!flags.json) { ctx.ui?.write?.(`Token ${result.tokenRecord.name}${result.tokenRecord.expiresAt ? ` (expires ${new Date(result.tokenRecord.expiresAt).toISOString()})` : ' (no expiry)'}:\n${result.token}\n`); }
        return {  token: result.token, tokenRecord: result.tokenRecord };
      }
      const response = await request('/auth/tokens');
      const result = await readGatewaySuccessData<{ tokens: TokenRecord[] }>(response, {
        operation: 'API token listing', gatewayUrl: gateway.gatewayUrl,
      });
      if (!flags.json && result.tokens.length === 0) {ctx.ui?.write?.('No API tokens. Create one with `kb auth tokens --name "nightly CI"`.\n');}
      else if (!flags.json) {ctx.ui?.write?.(result.tokens.map((token) => `${token.tokenId}  ${token.name}  ${token.expiresAt ? `expires ${new Date(token.expiresAt).toISOString()}` : 'no expiry'}${token.revokedAt ? '  revoked' : ''}`).join('\n') + '\n');}
      return {  tokens: result.tokens };
    } catch (error) {
      return showGatewayError(error);
    }
  },
});
