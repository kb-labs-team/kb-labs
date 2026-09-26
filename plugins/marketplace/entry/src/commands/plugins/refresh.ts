import * as fs from 'node:fs/promises';
import { resolveRuntimeStatePath } from '@kb-labs/core-project-registry';
import { defineCommand, handleError, type CLIInput, type PluginContextV3, type CommandResult } from '@kb-labs/sdk';

interface RefreshFlags {
  json?: boolean;
  'dry-run'?: boolean;
}

export default defineCommand<unknown, CLIInput<RefreshFlags>, unknown>({
  id: 'marketplace:plugins:refresh',
  description: 'Clear CLI discovery cache',

  handler: {
    async intent(_ctx: PluginContextV3, _input: CLIInput<RefreshFlags>) {
      return {
        summary: 'Clear CLI discovery cache',
        operations: [
          { type: 'delete' as const, resource: 'file', details: { path: 'state/<projectId>/cache/cli-manifests.json' } },
        ],
      };
    },

    async execute(ctx: PluginContextV3, input: CLIInput<RefreshFlags>): Promise<CommandResult> {
      const { flags = {} } = input;

      try {
        const cleared = await clearDiscoveryCache(ctx.cwd);

        if (flags.json) {
          ctx.ui?.json?.({ cleared });
        } else {
          ctx.ui?.success?.(
            cleared
              ? 'CLI discovery cache cleared. Run any kb command to rebuild.'
              : 'CLI discovery cache was already empty.',
          );
        }
        return { ok: true };
      } catch (err) {
        handleError(ctx, err, flags.json);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
});

/**
 * Removes the discovery cache from the project runtime-state directory and
 * from the legacy in-repo location (still read for one release).
 */
export async function clearDiscoveryCache(cwd: string): Promise<boolean> {
  const { path: stateFile, legacyPath } = resolveRuntimeStatePath(cwd, ['cache', 'cli-manifests.json']);
  let cleared = false;
  for (const cacheFile of [stateFile, legacyPath]) {
    try {
      await fs.unlink(cacheFile);
      cleared = true;
    } catch {
      // not present at this location
    }
  }
  return cleared;
}
