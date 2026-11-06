import { defineCommand, validationError, handleError, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';

import { post } from '../http.js';
import { resolveCliScope, scopeBody, CliScopeError } from '../scope.js';

interface UpdateFlags {
  json?: boolean;
  scope?: string;
  'dry-run'?: boolean;
}

interface UpdateInput {
  argv?: string[];
  flags?: UpdateFlags;
}

interface PackageEntry {
  id: string;
  version: string;
  primaryKind: string;
}

interface UpdateResultData {
  installed: PackageEntry[];
  warnings: string[];
  scope: string;
}

export default defineCommand<unknown, UpdateInput, UpdateResultData>({
  id: 'marketplace:update',
  description: 'Update marketplace package(s)',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: UpdateInput) {
      const argv = input.argv ?? [];
      const targets = argv.length > 0 ? argv : ['all installed packages'];
      return {
        summary: `Update ${targets.join(', ')}`,
        operations: targets.map(pkg => ({
          type: 'update' as const,
          resource: 'marketplace-package',
          details: { package: pkg },
        })),
      };
    },

    async execute(ctx: PluginCommandContextV3, input: UpdateInput): Promise<CommandResult<UpdateResultData>> {
      const argv = input.argv ?? [];
      const flags = (input.flags ?? input) as UpdateFlags;

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
        // Server-side update accepts a single body with the ids (or all
        // installed when omitted). No client-side loop; the server handles
        // per-package failures and reports them in `warnings`.
        const body: Record<string, unknown> = { ...scopeBody(scopeCtx) };
        if (argv.length > 0) {
          body.packageIds = argv;
        }
        const result = await post<UpdateResultData>('/packages/update', body);

        if (flags.json) {
          return result;
        } else if (result.installed.length === 0) {
          ctx.ui?.info?.(`Nothing to update (${scopeCtx.scope})`);
        } else {
          ctx.ui?.success?.(`Update completed (${scopeCtx.scope})`, {
            sections: [
              {
                header: 'Updated',
                items: result.installed.map(p => `${p.id}@${p.version} (${p.primaryKind})`),
              },
              ...(result.warnings.length > 0 ? [{ header: 'Warnings', items: result.warnings }] : []),
            ],
          });
        }

        return result;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
