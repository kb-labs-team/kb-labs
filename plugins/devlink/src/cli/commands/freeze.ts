import { defineCommand, useLoader, TimingTracker, handleError, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import { discoverMonorepos, buildPackageMapFiltered, buildPlan, freeze, loadState } from '../../core/index.js';
import type { LockFile } from '../../core/index.js';

interface FreezeFlags {
  json?: boolean;
}

interface FreezeInput {
  argv?: string[];
  flags?: FreezeFlags;
  json?: boolean;
}

export default defineCommand<unknown, FreezeInput, LockFile>({
  id: 'devlink:freeze',
  description: 'Freeze current dependency state to lock file',

  handler: {
    async intent(_ctx: PluginCommandContextV3, _input: FreezeInput) {
      return {
        summary: 'Freeze current dependency state to lock file',
        operations: [
          { type: 'create' as const, resource: 'file', details: { path: '.kb/devlink/lock.json' } },
        ],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: FreezeInput): Promise<CommandResult<LockFile>> {
      const tracker = new TimingTracker();
      const flags = (input.flags ?? input) as FreezeFlags;
      const outputJson = flags.json ?? false;

      const rootDir = ctx.cwd ?? process.cwd();

      const loader = useLoader('Freezing current state...');
      loader.start();

      let lock;
      try {
        const state = loadState(rootDir);
        const monorepos = discoverMonorepos(rootDir);
        const currentMode = state.currentMode ?? 'npm';
        const packageMap = await buildPackageMapFiltered(monorepos, rootDir, undefined, currentMode);
        const plan = buildPlan(currentMode, packageMap, monorepos, rootDir);
        lock = freeze(rootDir, plan);
      } catch (err) {
        loader.fail('Failed to freeze state');
        return handleError(err);
      }
      loader.succeed('State frozen');
      tracker.checkpoint('freeze');

      if (outputJson) {
        return lock;
      } else {
        ctx.ui?.success?.('Current state frozen to lock file', {
          title: 'DevLink — Freeze',
          sections: [
            {
              header: 'Lock file',
              items: [
                `Mode: ${lock.plan.mode}`,
                `Frozen at: ${lock.frozenAt}`,
                `Location: .kb/devlink/lock.json`,
              ],
            },
          ],
          timing: tracker.total(),
        });
      }

      return lock;
    },
  },
});
