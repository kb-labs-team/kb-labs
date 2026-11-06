import { defineSystemCommand, throwSystemCataloguedError, throwSystemCommandError, type CommandResult } from '@kb-labs/shared-command-kit';
import { gatewayApiFetch, readGatewaySuccessData } from '@kb-labs/sdk/gateway';
import { resolveActiveGateway } from '@kb-labs/cli-runtime/gateway';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import type { ErrorEnvelope } from '@kb-labs/core-platform';

function errorEnvelope(error: unknown): ErrorEnvelope | null {
  if (typeof error !== 'object' || error === null || !('envelope' in error)) { return null; }
  const envelope = error.envelope;
  return typeof envelope === 'object' && envelope !== null && 'code' in envelope && 'message' in envelope
    ? envelope as ErrorEnvelope
    : null;
}

type ResetLinkFlags = { 'user-id': { type: 'string'; description: string }; json: { type: 'boolean'; description: string } };

export const authResetLink = defineSystemCommand<ResetLinkFlags, CommandResult & { resetUrl?: string; expiresAt?: number }>({
  name: 'reset-link',
  scope: 'platform',
  jsonTest: { noSafeValidPath: "This command requests an account reset link." },
  description: 'Create an admin password reset link for a user',
  longDescription: 'Creates a one-time password reset link that expires after 24 hours. Share it with the user out of band.',
  category: 'auth',
  examples: ['kb auth reset-link --user-id usr_123', 'kb auth reset-link --user-id usr_123 --json'],
  flags: {
    'user-id': { type: 'string', description: 'User ID from `kb` user administration' },
    json: { type: 'boolean', description: 'Output in JSON format' },
  },
  async handler(ctx, _argv, flags) {
    const fail = (error: string) => {
      throwSystemCommandError(error, 'Run `kb auth reset-link --help` to review valid inputs and recovery steps, then retry.');
    };
    if (!flags['user-id']) { return fail('Provide --user-id. Run `kb auth reset-link --user-id <id>` after `kb auth login`.'); }
    try {
      const gateway = await resolveActiveGateway({ cwd: getContextCwd(ctx), env: process.env });
      const response = await gatewayApiFetch(`${gateway.gatewayUrl}/auth/users/${encodeURIComponent(flags['user-id'])}/password-reset-link`, { method: 'POST' }, gateway);
      const result = await readGatewaySuccessData<{ resetUrl: string; expiresAt: number }>(response, {
        operation: 'Password reset link creation', gatewayUrl: gateway.gatewayUrl,
      });
      if (!flags.json) { ctx.ui?.write?.(`Password reset link (expires ${new Date(result.expiresAt).toISOString()}):\n${result.resetUrl}\n`); }
      return {  resetUrl: result.resetUrl, expiresAt: result.expiresAt };
    } catch (error) {
      const envelope = errorEnvelope(error);
      if (envelope) {
        throwSystemCataloguedError(envelope);
      }
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});
