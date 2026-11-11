import { defineCommand, validationError, handleError, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';

import { post } from '../../http.js';
import { resolveCliScope, scopeBody, CliScopeError } from '../../scope.js';

interface DisableFlags { json?: boolean; scope?: string; 'dry-run'?: boolean }
interface DisableInput { argv?: string[]; flags?: DisableFlags }

export default defineCommand<unknown, DisableInput, { packageId: string; scope: string }>({
  id: 'marketplace:plugins:disable',
  description: 'Disable a plugin',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: DisableInput) {
      const packageId = input.argv?.[0] ?? '(unknown)';
      return {
        summary: `Disable plugin "${packageId}"`,
        operations: [{ type: 'update' as const, resource: 'plugin', details: { packageId, enabled: false } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: DisableInput): Promise<CommandResult<{ packageId: string; scope: string }>> {
      const packageId = input.argv?.[0];
      const flags = (input.flags ?? input) as DisableFlags;

      if (!packageId) {
        return validationError('Specify a plugin to disable', 'Usage: kb marketplace plugins disable <plugin-id>');
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
        await post(`/packages/disable`, { packageId, ...scopeBody(scopeCtx) });
        if (flags.json) {
          return { packageId, scope: scopeCtx.scope };
        } else {
          ctx.ui?.success?.(`Disabled ${packageId} (${scopeCtx.scope})`);
        }
        return { packageId, scope: scopeCtx.scope };
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
