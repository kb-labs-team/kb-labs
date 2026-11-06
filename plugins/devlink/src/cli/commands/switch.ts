import { defineCommand, useLoader, TimingTracker, handleError, type PluginCommandContextV3, type CommandResult, type CLIInput } from '@kb-labs/sdk';
import { discoverMonorepos, buildPackageMapFiltered, buildPlan, applyPlan, createBackup, loadState, saveState, checkGitDirty, updateWorkspaceYamls } from '../../core/index.js';
import type { DevlinkMode } from '../../contracts/index.js';
import { existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

interface SwitchFlags {
  mode: DevlinkMode;
  'dry-run'?: boolean;
  repos?: string;
  yes?: boolean;
  json?: boolean;
  ttl?: number;
  install?: boolean;
  'clean-locks'?: boolean;
}

interface SwitchResult {
  mode: DevlinkMode;
  changed: number;
  backupId?: string;
  cleanedLocks?: number;
  wsUpdates?: number;
  installedRepos?: number;
  installErrors?: string[];
}

export default defineCommand<unknown, CLIInput<SwitchFlags>, SwitchResult>({
  id: 'devlink:switch',
  description: 'Switch cross-repo deps between link: and npm mode',

  handler: {
    async intent(ctx: PluginCommandContextV3, input: CLIInput<SwitchFlags>) {
      const flags = input.flags;
      const mode = flags.mode;
      const rootDir = ctx.cwd ?? process.cwd();
      const scopedRepos = flags.repos ? flags.repos.split(',').map(s => s.trim()) : undefined;
      const ttlMs = (flags.ttl ?? 24) * 60 * 60 * 1000;

      let monorepos;
      let packageMap;
      try {
        monorepos = discoverMonorepos(rootDir);
        packageMap = await buildPackageMapFiltered(monorepos, rootDir, ttlMs, mode);
      } catch {
        return {
          summary: `Switch dependencies to ${mode ?? '(unknown)'} mode`,
          operations: [{ type: 'update' as const, resource: 'package-json', details: { mode } }],
        };
      }

      const plan = buildPlan(mode, packageMap, monorepos, rootDir, { scopedRepos });
      const byRepo = new Map<string, number>();
      for (const item of plan.items) {
        byRepo.set(item.monorepo, (byRepo.get(item.monorepo) ?? 0) + 1);
      }

      return {
        summary: `Switch ${plan.items.length} dependencies to ${mode} mode across ${byRepo.size} repo(s)`,
        operations: [...byRepo.entries()].map(([repo, count]) => ({
          type: 'update' as const,
          resource: 'dependencies',
          details: { repo, count, mode },
        })),
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<SwitchFlags>): Promise<CommandResult<SwitchResult>> {
      const tracker = new TimingTracker();
      const flags = input.flags;
      const mode = flags.mode;
      const outputJson = flags.json ?? false;
      const scopedRepos = flags.repos ? flags.repos.split(',').map(s => s.trim()) : undefined;
      const ttlMs = (flags.ttl ?? 24) * 60 * 60 * 1000;

      const rootDir = ctx.cwd ?? process.cwd();

      // 1. Discover
      const discoverLoader = useLoader('Discovering monorepos...');
      discoverLoader.start();

      let monorepos;
      let packageMap;
      try {
        monorepos = discoverMonorepos(rootDir);
        packageMap = await buildPackageMapFiltered(monorepos, rootDir, ttlMs, mode);
      } catch (err) {
        discoverLoader.fail('Discovery failed');
        return handleError(err);
      }
      discoverLoader.succeed(`Found ${monorepos.length} monorepos, ${Object.keys(packageMap).length} packages`);
      tracker.checkpoint('discovery');

      // 2. Warn if git dirty
      const dirtyFiles = checkGitDirty(rootDir);
      if (dirtyFiles.length > 0) {
        ctx.ui?.warn?.(`Working tree has ${dirtyFiles.length} uncommitted changes`);
      }

      // 3. Build plan
      const plan = buildPlan(mode, packageMap, monorepos, rootDir, { scopedRepos });
      tracker.checkpoint('plan');

      if (plan.items.length === 0 && !flags.install) {
        ctx.ui?.info?.('No changes needed — dependencies are already in the requested mode.');
        return { mode, changed: 0 };
      }

      // 4. Always create backup (even if no deps change — install cleans node_modules)
      const currentState = loadState(rootDir);
      const modeAtBackup = currentState.currentMode ?? mode;
      const allPackageJsons = monorepos.flatMap(m => m.packagePaths);
      const backup = createBackup(rootDir, allPackageJsons, `pre-switch to ${mode}`, modeAtBackup);
      const backupId = backup.id;
      tracker.checkpoint('backup');

      // 6. Apply dep changes (if any)
      let applyResult = { applied: 0, skipped: 0, errors: [] as Array<{ file: string; error: string }> };
      if (plan.items.length > 0) {
        const applyLoader = useLoader(`Switching ${plan.items.length} dependencies to ${mode} mode...`);
        applyLoader.start();
        applyResult = await applyPlan(plan, { dryRun: false });
        applyLoader.succeed(`Applied ${applyResult.applied} change(s)`);
        tracker.checkpoint('apply');
      }

      // 7. Update sub-repo pnpm-workspace.yaml with correct cross-repo paths
      const wsLoader = useLoader('Updating sub-repo workspace files...');
      wsLoader.start();
      const wsUpdates = updateWorkspaceYamls(monorepos, packageMap, rootDir);
      const wsChanged = wsUpdates.reduce((sum, u) => sum + u.added.length + u.removed.length, 0);
      wsLoader.succeed(wsChanged > 0
        ? `Updated ${wsUpdates.length} workspace file(s) (${wsChanged} path changes)`
        : 'Workspace files up to date'
      );
      tracker.checkpoint('workspace-yaml');

      // 8. Save state
      saveState(rootDir, {
        currentMode: mode,
        lastApplied: new Date().toISOString(),
        frozenAt: currentState.frozenAt,
      });

      // 9. Clean stale lockfiles + node_modules in all sub-repos (default: true)
      const shouldClean = flags['clean-locks'] !== false;
      let cleanedLocks = 0;
      let cleanedNodeModules = 0;
      if (shouldClean) {
        const cleanLoader = useLoader('Cleaning stale lockfiles and node_modules...');
        cleanLoader.start();
        for (const mono of monorepos) {
          // Clean lockfile
          const lockPath = join(mono.rootPath, 'pnpm-lock.yaml');
          if (existsSync(lockPath)) {
            try { unlinkSync(lockPath); cleanedLocks++; } catch { /* skip */ }
          }
          // Clean node_modules (contains stale shims with hardcoded paths)
          const nmPath = join(mono.rootPath, 'node_modules');
          if (existsSync(nmPath)) {
            try { rmSync(nmPath, { recursive: true, force: true }); cleanedNodeModules++; } catch { /* skip */ }
          }
        }
        cleanLoader.succeed(
          `Cleaned ${cleanedLocks} lockfile(s), ${cleanedNodeModules} node_modules`
        );
        tracker.checkpoint('clean');
      }

      // 10. Install: workspace root first, then per-sub-repo
      const shouldInstall = flags.install === true;
      let installedRepos = 0;
      const installErrors: string[] = [];
      if (shouldInstall) {
        // Phase 1: workspace root install
        const rootLoader = useLoader('Installing workspace root...');
        rootLoader.start();
        try {
          execSync('pnpm install --no-frozen-lockfile', {
            cwd: rootDir,
            stdio: 'pipe',
            timeout: 180_000,
          });
          rootLoader.succeed('Workspace root installed');
        } catch (err) {
          rootLoader.succeed('Workspace root install failed');
          installErrors.push(`root: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
        }
        tracker.checkpoint('root-install');

        // Phase 2: per-sub-repo install (affected + repos missing lockfile)
        const affectedRepos = new Set(plan.items.map(i => i.monorepo));
        const affectedMonorepos = monorepos.filter(m =>
          affectedRepos.has(m.name) || !existsSync(join(m.rootPath, 'pnpm-lock.yaml'))
        );
        const repoLoader = useLoader(`Installing ${affectedMonorepos.length} sub-repo(s)...`);
        repoLoader.start();
        for (const mono of affectedMonorepos) {
          try {
            execSync('pnpm install --no-frozen-lockfile --prefer-offline', {
              cwd: mono.rootPath,
              stdio: 'pipe',
              timeout: 300_000, // 5 min per sub-repo
            });
            installedRepos++;
          } catch (err) {
            installErrors.push(`${mono.name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
          }
        }
        repoLoader.succeed(`Installed ${installedRepos}/${affectedMonorepos.length} sub-repo(s)${installErrors.length > 0 ? `, ${installErrors.length} failed` : ''}`);
        tracker.checkpoint('sub-repo-install');
      }

      // 11. Output
      const result: SwitchResult = {
        mode,
        changed: applyResult.applied,
        backupId,
      };

      if (outputJson) {
        return { ...result, cleanedLocks, wsUpdates: wsUpdates.length, installedRepos, installErrors };
      } else {
        const summaryItems = [
          `Mode: ${mode}`,
          `Changed: ${applyResult.applied} dependencies`,
          `Backup: ${backupId}`,
        ];
        if (wsChanged > 0) {
          summaryItems.push(`Workspace YAMLs: ${wsUpdates.length} updated`);
        }
        if (cleanedLocks > 0 || cleanedNodeModules > 0) {
          summaryItems.push(`Cleaned: ${cleanedLocks} lockfile(s), ${cleanedNodeModules} node_modules`);
        }
        if (shouldInstall) {
          summaryItems.push(`Installed: root + ${installedRepos} sub-repo(s)`);
        }

        const sections = [
          { header: 'Summary', items: summaryItems },
          ...(applyResult.errors.length > 0
            ? [{ header: 'Errors', items: applyResult.errors.map(e => `${e.file}: ${e.error}`) }]
            : []),
          ...(installErrors.length > 0
            ? [{ header: 'Install errors', items: installErrors }]
            : []),
          ...(!shouldInstall && applyResult.applied > 0
            ? [{ header: 'Next step', items: ['Re-run with --install to complete setup'] }]
            : []),
        ];
        ctx.ui?.success?.(`Switched to ${mode} mode`, {
          title: 'DevLink — Switch',
          sections,
          timing: tracker.total(),
        });
      }

      return result;
    },
  },
});
