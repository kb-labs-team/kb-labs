import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineCommand, type CLIInput, type PluginCommandContextV3 , type CommandResult} from '@kb-labs/sdk';
import { analyzeCiReliability, loadCiDossiers } from '../../core/index.js';
import type { QaCiOverviewFlags } from './flags.js';

export default defineCommand<unknown, CLIInput<QaCiOverviewFlags>, unknown>({
  id: 'qa:ci-overview',
  description: 'Show a compact CI reliability overview from captured dossiers',
  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<QaCiOverviewFlags>): Promise<CommandResult> {
      const cwd = ctx.cwd ?? process.cwd();
      const inputPath = resolve(cwd, input.flags.input);
      const dossiers = loadCiDossiers(inputPath);
      if (dossiers.length === 0) {

        return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: `No CI dossiers were found under ${inputPath}.`, hint: 'Run `kb qa ci evidence create` in CI, then rerun `kb qa ci overview show`.' } };
      }
      const overview = analyzeCiReliability(dossiers);
      if (input.flags.output) {
        const output = resolve(cwd, input.flags.output);
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, `${JSON.stringify(overview, null, 2)}\n`);
      }
      if (input.flags.json) {
        return overview;
      } else {
        ctx.ui?.success?.(`CI reliability (${overview.runsAnalyzed} run${overview.runsAnalyzed === 1 ? '' : 's'})`, {
          sections: [
            { header: 'Summary', items: [
              `failed runs: ${overview.failedRuns}`,
              `failed before tests: ${overview.failedBeforeTests}`,
              `evidence: ${overview.collection.complete} complete, ${overview.collection.partial} partial`,
              ...(input.flags.output ? [`saved JSON: ${resolve(cwd, input.flags.output)}`] : []),
            ] },
            { header: 'Top findings', items: overview.findings.length > 0
              ? overview.findings.map(finding => `${finding.fingerprint} — ${finding.occurrences} occurrence(s), ${(finding.confidence * 100).toFixed(0)}% confidence; ${finding.affectedJobs.join(', ')}`)
              : ['No failed CI steps in the captured evidence.'] },
            { header: 'Drill down', items: overview.drillDown.runIds.map(runId => `kb qa ci run --run-id ${runId} --json`) },
          ],
        });
      }
      return {  };
    },
  },
});
