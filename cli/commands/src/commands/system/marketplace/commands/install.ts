import { defineCommand, validationError, handleError, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';

import { post } from '../http.js';
import { resolveCliScope, scopeBody, CliScopeError } from '../scope.js';

interface InstallFlags {
  dev?: boolean;
  json?: boolean;
  scope?: string;
  token?: string;
  'dry-run'?: boolean;
}

interface InstallInput {
  argv?: string[];
  flags?: InstallFlags;
}

interface InstalledEntry {
  id: string;
  version: string;
  primaryKind: string;
  source: 'registry' | 'npm' | 'local';
  signatureStatus: 'verified' | 'unsigned' | 'not-applicable';
}

interface InstallResultData {
  installed: InstalledEntry[];
  warnings: string[];
  scope: string;
}

export default defineCommand<unknown, InstallInput, InstallResultData>({
  id: 'marketplace:install',
  description: 'Install package(s) from marketplace',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: InstallInput) {
      const argv = input.argv ?? [];
      const packages = argv.length > 0 ? argv : ['(no packages specified)'];
      return {
        summary: `Install ${packages.join(', ')} from marketplace`,
        operations: packages.map(pkg => ({
          type: 'create' as const,
          resource: 'marketplace-package',
          details: { package: pkg },
        })),
      };
    },

    async execute(ctx: PluginCommandContextV3, input: InstallInput): Promise<CommandResult<InstallResultData>> {
      const argv = input.argv ?? [];
      const flags = (input.flags ?? input) as InstallFlags;

      if (argv.length === 0) {
        return validationError('Please specify at least one package to install', 'Usage: kb marketplace install <package>');
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
        const result = await post<InstallResultData>('/packages/install', {
          specs: argv,
          dev: Boolean(flags.dev),
          ...(flags.token ? { token: flags.token } : {}),
          ...scopeBody(scopeCtx),
        });

        if (flags.json) {
          return result;
        } else {
          ctx.ui?.success?.(`Marketplace install completed (${result.scope ?? scopeCtx.scope})`, {
            sections: [
              {
                header: 'Installed',
                items: result.installed.map(p => `${p.id}@${p.version} (${p.primaryKind}; ${p.signatureStatus}/${p.source})`),
              },
              ...(result.warnings.length > 0
                ? [{ header: 'Warnings', items: result.warnings }]
                : []),
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
