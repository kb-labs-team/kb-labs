import { defineCommand, validationError, handleError, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';

import { post } from '../../http.js';
import { resolveCliScope, scopeBody, CliScopeError } from '../../scope.js';

interface RemoveFlags {
  json?: boolean;
  scope?: string;
  'dry-run'?: boolean;
}

interface RemoveInput {
  argv?: string[];
  flags?: RemoveFlags;
}

export default defineCommand<unknown, RemoveInput, { packageId: string; scope: string }>({
  id: 'marketplace:plugins:remove',
  description: 'Remove a local project plugin registration',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: RemoveInput) {
      const packageId = input.argv?.[0] ?? '(unknown)';
      return {
        summary: `Remove plugin registration "${packageId}"`,
        operations: [{ type: 'delete' as const, resource: 'plugin-link', details: { packageId } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: RemoveInput): Promise<CommandResult<{ packageId: string; scope: string }>> {
      const packageId = input.argv?.[0];
      const flags = (input.flags ?? input) as RemoveFlags;

      if (!packageId) {
        return validationError('Specify a package ID to remove', 'Usage: kb marketplace plugins remove <plugin-id>');
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
        await post(`/packages/unlink`, { packageId, ...scopeBody(scopeCtx) });
        if (flags.json) {
          return { packageId, scope: scopeCtx.scope };
        } else {
          ctx.ui?.success?.(`Removed ${packageId} (${scopeCtx.scope})`);
        }
        return { packageId, scope: scopeCtx.scope };
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
