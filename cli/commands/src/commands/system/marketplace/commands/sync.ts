import { defineCommand, parseJsonc, useEnv, validationError, handleError, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';

import { post } from '../http.js';
import { resolveCliScope, scopeBody, CliScopeError } from '../scope.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface SyncFlags {
  'auto-enable'?: boolean;
  json?: boolean;
  scope?: string;
  'dry-run'?: boolean;
}

interface SyncInput {
  argv?: string[];
  flags?: SyncFlags;
}

interface SyncEntry {
  id: string;
  primaryKind: string;
  version: string;
}

interface SyncResultData {
  added: SyncEntry[];
  skipped: Array<{ id: string; reason: string }>;
  total: number;
}

export default defineCommand<unknown, SyncInput, SyncResultData>({
  id: 'marketplace:sync',
  description: 'Sync workspace — scan for entities and populate lock',

  handler: {
    async intent(_ctx: PluginCommandContextV3, _input: SyncInput) {
      return {
        summary: 'Sync workspace — scan for entities and populate lock file',
        operations: [
          { type: 'update' as const, resource: 'marketplace-lock', details: { action: 'sync-workspace' } },
        ],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: SyncInput): Promise<CommandResult<SyncResultData>> {
      const flags = (input.flags ?? input) as SyncFlags;
      const cwd = ctx.cwd ?? process.cwd();

      let scopeCtx;
      try {
        scopeCtx = await resolveCliScope(cwd, flags.scope);
      } catch (err) {
        if (err instanceof CliScopeError) {
          return validationError(err.message);
        } else {
          return handleError(err);
        }
      }

      // Sync reads include/exclude patterns from the config file located at
      // the scope root, not from the CLI cwd. This keeps semantics consistent:
      // `--scope project` syncs using the project's config, `--scope platform`
      // uses the platform config.
      const configRoot = scopeCtx.scope === 'project' && scopeCtx.projectRoot
        ? scopeCtx.projectRoot
        : cwd;
      let syncConfig: { include?: string[]; exclude?: string[] };
      try {
        syncConfig = await loadSyncConfig(configRoot);
      } catch (error) {
        const message = error instanceof Error ? error.message : `Cannot read marketplace sync config in ${configRoot}/.kb.`;
        return validationError(message, `Correct the config, then rerun \`kb marketplace sync --scope ${scopeCtx.scope}\`.`);
      }

      if (!syncConfig.include?.length) {
        return validationError(
          `No marketplace.sync.include configured in ${configRoot}/.kb/kb.config.jsonc.`,
          `Add marketplace.sync.include, then rerun \`kb marketplace sync --scope ${scopeCtx.scope}\`.`,
        );
      }

      try {
        const isDev = (useEnv('NODE_ENV') ?? 'development') === 'development';
        const result = await post<SyncResultData>('/workspace/sync', {
          include: syncConfig.include,
          exclude: syncConfig.exclude,
          autoEnable: flags['auto-enable'] !== undefined ? Boolean(flags['auto-enable']) : isDev,
          ...scopeBody(scopeCtx),
        });

        if (flags.json) {
          return result;
        } else if (result.added.length === 0) {
          ctx.ui?.info?.(`Lock is up to date — ${scopeCtx.scope} (${result.total} entries)`);
        } else {
          ctx.ui?.success?.(`Synced ${result.added.length} new entries to ${scopeCtx.scope} (${result.total} total)`, {
            sections: [{
              header: 'Added',
              items: result.added.map(e => `+ ${e.id} (${e.primaryKind}) v${e.version}`),
            }],
          });
        }

        return result;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});

async function loadSyncConfig(root: string): Promise<{ include?: string[]; exclude?: string[] }> {
  for (const name of ['kb.config.jsonc', 'kb.config.json']) {
    const p = path.join(root, '.kb', name);
    let raw: string;
    try {
      raw = await fs.readFile(p, 'utf-8');
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw new Error(`Cannot read marketplace sync config ${p}: ${errorMessage(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = name.endsWith('.jsonc') ? parseJsonc(raw) : JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid marketplace sync config ${p}: ${errorMessage(error)}`);
    }

    if (typeof parsed !== 'object' || parsed === null || !('marketplace' in parsed)) return {};
    const marketplace = parsed.marketplace;
    if (typeof marketplace !== 'object' || marketplace === null || !('sync' in marketplace)) return {};
    const sync = marketplace.sync;
    if (typeof sync !== 'object' || sync === null) return {};
    const include = 'include' in sync && Array.isArray(sync.include) && sync.include.every((item): item is string => typeof item === 'string')
      ? sync.include
      : undefined;
    const exclude = 'exclude' in sync && Array.isArray(sync.exclude) && sync.exclude.every((item): item is string => typeof item === 'string')
      ? sync.exclude
      : undefined;
    return { include, exclude };
  }
  return {};
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
