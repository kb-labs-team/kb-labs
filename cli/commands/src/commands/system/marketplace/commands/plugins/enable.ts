import { defineCommand, validationError, handleError, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';

import { post } from '../../http.js';
import { resolveCliScope, scopeBody, CliScopeError } from '../../scope.js';

interface EnableFlags { json?: boolean; scope?: string; 'dry-run'?: boolean }
interface EnableInput { argv?: string[]; flags?: EnableFlags }

export default defineCommand<unknown, EnableInput, { packageId: string; scope: string }>({
  id: 'marketplace:plugins:enable',
  description: 'Enable a plugin',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: EnableInput) {
      const packageId = input.argv?.[0] ?? '(unknown)';
      return {
        summary: `Enable plugin "${packageId}"`,
        operations: [{ type: 'update' as const, resource: 'plugin', details: { packageId, enabled: true } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: EnableInput): Promise<CommandResult<{ packageId: string; scope: string }>> {
      const packageId = input.argv?.[0];
      const flags = (input.flags ?? input) as EnableFlags;

      if (!packageId) {
        return validationError('Specify a plugin to enable', 'Usage: kb marketplace plugins enable <plugin-id>');
      }

      let scopeCtx;
      try {
        scopeCtx = await resolveCliScope(ctx.cwd, flags.scope);
      } catch (err) {
        if (err instanceof CliScopeError) {
          return validationError(err.message);
        } else {
          return handleError(err);
        }
              }

      try {
        await post(`/packages/enable`, { packageId, ...scopeBody(scopeCtx) });
        if (flags.json) {
          return { packageId, scope: scopeCtx.scope };
        } else {
          ctx.ui?.success?.(`Enabled ${packageId} (${scopeCtx.scope})`);
        }
        return { packageId, scope: scopeCtx.scope };
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
