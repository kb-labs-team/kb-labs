import { defineCommand, validationError, handleError, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';

import { post } from '../http.js';
import { resolveCliScope, scopeBody, CliScopeError } from '../scope.js';

interface UninstallFlags {
  json?: boolean;
  scope?: string;
  'dry-run'?: boolean;
}

interface UninstallInput {
  argv?: string[];
  flags?: UninstallFlags;
}

export default defineCommand<unknown, UninstallInput, { removed: string[]; scope: string }>({
  id: 'marketplace:uninstall',
  description: 'Uninstall package(s) from marketplace',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: UninstallInput) {
      const argv = input.argv ?? [];
      const packages = argv.length > 0 ? argv : ['(no packages specified)'];
      return {
        summary: `Uninstall ${packages.join(', ')} from marketplace`,
        operations: packages.map(pkg => ({
          type: 'delete' as const,
          resource: 'marketplace-package',
          details: { package: pkg },
        })),
      };
    },

    async execute(ctx: PluginCommandContextV3, input: UninstallInput): Promise<CommandResult<{ removed: string[]; scope: string }>> {
      const argv = input.argv ?? [];
      const flags = (input.flags ?? input) as UninstallFlags;

      if (argv.length === 0) {
        return validationError('Please specify at least one package to uninstall', 'Usage: kb marketplace uninstall <package>');
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
        // Server returns 204 on success; treat that as "everything you asked for
        // was removed" so the CLI has something to render.
        await post('/packages/uninstall', {
          packageIds: argv,
          ...scopeBody(scopeCtx),
        });

        if (flags.json) {
          return { removed: argv, scope: scopeCtx.scope };
        } else {
          ctx.ui?.success?.(`Removed from ${scopeCtx.scope}: ${argv.join(', ')}`);
        }
        return { removed: argv, scope: scopeCtx.scope };
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
