import { defineCommand, useLoader, TimingTracker, handleError, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import { discoverMonorepos, buildPackageMapFiltered, analyzePackageDeps, loadState, diagnose } from '../../core/index.js';
import type { DevlinkStatus, DiagnosticIssue } from '../../contracts/index.js';

interface StatusFlags {
  json?: boolean;
}

interface StatusInput {
  argv?: string[];
  flags?: StatusFlags;
  json?: boolean;
}

interface StatusResult extends DevlinkStatus {
  diagnostics: DiagnosticIssue[];
}

export default defineCommand<unknown, StatusInput, StatusResult>({
  id: 'devlink:status',
  description: 'Show current state of cross-repo dependencies with diagnostics',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: StatusInput): Promise<CommandResult<StatusResult>> {
      const tracker = new TimingTracker();
      const flags = (input.flags ?? input) as StatusFlags;
      const outputJson = flags.json ?? false;

      const rootDir = ctx.cwd ?? process.cwd();

      const loader = useLoader('Analyzing dependencies...');
      loader.start();

      let state: ReturnType<typeof loadState>;
      let totalLink = 0;
      let totalNpm = 0;
      let totalWorkspace = 0;
      let diagnostics: ReturnType<typeof diagnose>;
      try {
        state = loadState(rootDir);
        const monorepos = discoverMonorepos(rootDir);
        const packageMap = await buildPackageMapFiltered(monorepos, rootDir);

        for (const monorepo of monorepos) {
          for (const pkgPath of monorepo.packagePaths) {
            const counts = analyzePackageDeps(pkgPath, packageMap);
            totalLink += counts.linkCount;
            totalNpm += counts.npmCount;
            totalWorkspace += counts.workspaceCount;
          }
        }

        diagnostics = diagnose(monorepos, packageMap, rootDir);
      } catch (err) {
        loader.fail('Analysis failed');
        return handleError(err);
      }

      loader.succeed('Analysis complete');
      tracker.checkpoint('analysis');

      const errors = diagnostics.filter(d => d.severity === 'error');
      const warnings = diagnostics.filter(d => d.severity === 'warning');

      const result: StatusResult = {
        currentMode: state.currentMode,
        lastApplied: state.lastApplied,
        linkCount: totalLink,
        npmCount: totalNpm,
        workspaceCount: totalWorkspace,
        discrepancies: [],
        diagnostics,
      };

      if (outputJson) {
        return result;
      } else {
        const sections = [
          {
            header: 'Current mode',
            items: [
              `Mode: ${state.currentMode ?? 'unknown'}`,
              `Last applied: ${state.lastApplied ?? 'never'}`,
            ],
          },
          {
            header: 'Dependency counts',
            items: [
              `link: (local)   : ${totalLink}`,
              `npm (^version)  : ${totalNpm}`,
              `workspace:*     : ${totalWorkspace}`,
            ],
          },
        ];

        if (errors.length > 0) {
          sections.push({
            header: `❌ Errors (${errors.length})`,
            items: errors.slice(0, 10).map(d => `${d.dep ?? d.file}: ${d.message}`),
          });
        }

        if (warnings.length > 0) {
          sections.push({
            header: `⚠ Warnings (${warnings.length})`,
            items: warnings.slice(0, 10).map(d => `${d.dep ?? d.file}: ${d.message}`),
          });
        }

        if (diagnostics.length === 0) {
          sections.push({ header: '✅ Health', items: ['No issues detected'] });
        } else {
          sections.push({
            header: 'Fix',
            items: ['Run: kb devlink mode set --mode=local --install'],
          });
        }

        ctx.ui?.success?.('Dependency status', {
          title: 'DevLink — Status',
          sections,
          timing: tracker.total(),
        });
      }

      return result;
    },
  },
});
