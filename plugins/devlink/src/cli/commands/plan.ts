import { defineCommand, useLoader, TimingTracker, handleError, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import { discoverMonorepos, buildPackageMapFiltered, buildPlan, groupByMonorepo, loadState } from '../../core/index.js';
import type { DevlinkMode, DevlinkPlan } from '../../contracts/index.js';

interface PlanFlags {
  mode?: DevlinkMode;
  repos?: string;
  json?: boolean;
  ttl?: number;
}

interface PlanInput {
  argv?: string[];
  flags?: PlanFlags;
  mode?: DevlinkMode;
  repos?: string;
  json?: boolean;
}

export default defineCommand<unknown, PlanInput, DevlinkPlan>({
  id: 'devlink:plan',
  description: 'Preview what would change when switching mode',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: PlanInput): Promise<CommandResult<DevlinkPlan>> {
      const tracker = new TimingTracker();
      const flags = (input.flags ?? input) as PlanFlags;
      const outputJson = flags.json ?? false;
      const scopedRepos = flags.repos ? flags.repos.split(',').map(s => s.trim()) : undefined;
      const ttlMs = (flags.ttl ?? 24) * 60 * 60 * 1000;

      const rootDir = ctx.cwd ?? process.cwd();

      const loader = useLoader('Building plan...');
      loader.start();

      let plan;
      let targetMode: DevlinkMode;
      let currentModeBefore: DevlinkMode | undefined;
      try {
        const state = loadState(rootDir);
        currentModeBefore = state.currentMode ?? undefined;
        const monorepos = discoverMonorepos(rootDir);
        targetMode = flags.mode ?? (state.currentMode === 'npm' ? 'local' : 'npm');
        const packageMap = await buildPackageMapFiltered(monorepos, rootDir, ttlMs, targetMode);
        plan = buildPlan(targetMode, packageMap, monorepos, rootDir, { scopedRepos });
      } catch (err) {
        loader.fail('Failed to build plan');
        return handleError(err);
      }
      loader.succeed(`Plan ready: ${plan.items.length} change(s)`);
      tracker.checkpoint('plan');

      if (outputJson) {
        return plan;
      } else {
        if (plan.items.length === 0) {
          ctx.ui?.info?.('No changes needed — already in the target mode.');
        } else {
          const byRepo = groupByMonorepo(plan.items);
          // Unique packages in npm map
          const uniquePkgs = new Set(plan.items.map(i => i.depName)).size;
          const uniqueFiles = new Set(plan.items.map(i => i.packageJsonPath)).size;

          const sections = [...byRepo.entries()].map(([repo, items]) => {
            // Group by depName within each repo — show "×N files" instead of N lines
            const byDep = new Map<string, { from: string; to: string; count: number }>();
            for (const item of items) {
              const existing = byDep.get(item.depName);
              if (existing) {
                existing.count++;
              } else {
                byDep.set(item.depName, { from: item.from, to: item.to, count: 1 });
              }
            }
            return {
              header: `${repo} (${byDep.size} dep${byDep.size !== 1 ? 's' : ''})`,
              items: [...byDep.entries()].map(([dep, { from, to, count }]) =>
                count > 1
                  ? `${dep}: ${from} → ${to}  ×${count} files`
                  : `${dep}: ${from} → ${to}`
              ),
            };
          });

          ctx.ui?.sideBox?.({
            title: 'DevLink — Plan',
            status: 'info',
            summary: {
              'Mode': `${currentModeBefore ?? '?'} → ${targetMode}`,
              'Packages': uniquePkgs,
              'Files affected': uniqueFiles,
              'Total changes': plan.items.length,
            },
            sections: [
              ...sections,
              { header: 'Next step', items: [`kb devlink mode set --mode=${targetMode}`] },
            ],
            timing: tracker.total(),
          });
        }
      }

      return plan;
    },
  },
});
