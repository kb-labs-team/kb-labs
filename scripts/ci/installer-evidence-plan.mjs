import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arch, platform, version } from 'node:process';
import { fileURLToPath } from 'node:url';

export function evidencePlan(indexBytes, nodeVersion = version(), host = { platform, arch }) {
  const index = JSON.parse(indexBytes.toString('utf8'));
  if (index.schema !== 'kb.create.release-index/v2') throw new Error('candidate release index has an unsupported schema');
  const nodeMajor = /^v?(\d+)\./.exec(nodeVersion)?.[1];
  if (!nodeMajor) throw new Error('coverage runner Node version is unavailable');
  const machine = ({ x64: 'x64', arm64: 'arm64' })[host.arch] ?? host.arch;
  return {
    schema: 'kb.qa-evidence-plan/v1',
    mode: 'local',
    candidateId: `sha256:${createHash('sha256').update(indexBytes).digest('hex')}`,
    profile: { os: `${host.platform}-${machine}`, runtime: `node-${nodeMajor}`, surface: 'cli' },
  };
}

export function selectLocalInstallerEvidence(reportDirectory) {
  return readdirSync(reportDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith('installer-case-local-') && entry.name.endsWith('.json'))
    .map((entry) => join(reportDirectory, entry.name))
    .filter((path) => {
      try {
        const wrapper = JSON.parse(readFileSync(path, 'utf8'));
        const run = wrapper?.case_run;
        return run?.schema === 'kb.qa-case-run/v3' && run.mode === 'local'
          && run.claims?.some((claim) => claim.claimId === 'PC-001.2');
      } catch { return false; }
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [indexPath, outputPath, reportDirectory] = process.argv.slice(2);
  if (!indexPath || !outputPath || !reportDirectory) throw new Error('usage: node installer-evidence-plan.mjs <release-index.json> <plan.json> <reports-dir>');
  const plan = evidencePlan(readFileSync(indexPath));
  writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
  const records = selectLocalInstallerEvidence(reportDirectory);
  if (records.length) process.stdout.write(records.join(','));
}
