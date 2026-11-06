import { defineCommand, validationError, handleError, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';

import { get } from '../../http.js';
import { resolveCliQueryScope, CliScopeError } from '../../scope.js';

interface ListFlags {
  json?: boolean;
  scope?: string;
}
interface ListInput { argv?: string[]; flags?: ListFlags }

interface EntryRow {
  id: string;
  version: string;
  source: string;
  primaryKind: string;
  provides: string[];
  enabled: boolean;
  scope: 'platform' | 'project';
}

interface ListResultData {
  entries: EntryRow[];
  total: number;
}

export default defineCommand<unknown, ListInput, ListResultData>({
  id: 'marketplace:plugins:list',
  description: 'List installed plugins',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: ListInput): Promise<CommandResult<ListResultData>> {
      const flags = (input.flags ?? input) as ListFlags;

      let scopeCtx;
      try {
        scopeCtx = await resolveCliQueryScope(ctx.cwd, flags.scope);
      } catch (err) {
        if (err instanceof CliScopeError) {
          return validationError(err.message);
        } else {
          return handleError(err);
        }
              }

      try {
        const query: Record<string, string> = { kind: 'plugin', scope: scopeCtx.scope };
        if (scopeCtx.projectRoot) {
          query.projectRoot = scopeCtx.projectRoot;
        }
        const data = await get<ListResultData>('/packages', query);

        if (flags.json) {
          return data;
        } else {
          const enabled = data.entries.filter(e => e.enabled !== false).length;
          const disabled = data.total - enabled;
          const showScopeColumn = scopeCtx.scope === 'all';
          ctx.ui?.success?.(`${data.total} plugins (${enabled} enabled, ${disabled} disabled) — scope=${scopeCtx.scope}`, {
            sections: [{
              header: 'Plugins',
              items: data.entries.map(e => {
                const icon = e.enabled !== false ? '✅' : '⏸';
                const scopeTag = showScopeColumn ? ` [${e.scope}]` : '';
                return `${icon} ${e.id} ${e.version} (${e.source})${scopeTag}`;
              }),
            }],
          });
        }

        return data;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
