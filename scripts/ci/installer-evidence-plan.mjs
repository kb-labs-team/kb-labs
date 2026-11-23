import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This pilot cell is scoped by PC-001 (CLI/local) and the Linux installer
// journey lane. Node major comes from the checked-in toolchain policy.
export function evidencePlan(indexBytes, nodePolicyBytes) {
  const index = JSON.parse(indexBytes.toString('utf8'));
  if (index.schema !== 'kb.create.release-index/v2') throw new Error('candidate release index has an unsupported schema');
  const nodePolicy = JSON.parse(nodePolicyBytes.toString('utf8'));
  const nodeMajor = nodePolicy.requiredMajor;
  if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 1) throw new Error('toolchain policy has no valid required Node major');
  return {
    schema: 'kb.qa-evidence-plan/v1',
    mode: 'local',
    candidateId: `sha256:${createHash('sha256').update(indexBytes).digest('hex')}`,
    profile: { os: 'linux-x64', runtime: `node-${nodeMajor}`, surface: 'cli' },
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
  const [indexPath, policyPath, outputPath, reportDirectory] = process.argv.slice(2);
  if (!indexPath || !policyPath || !outputPath || !reportDirectory) throw new Error('usage: node installer-evidence-plan.mjs <release-index.json> <node-policy.json> <plan.json> <reports-dir>');
  const plan = evidencePlan(readFileSync(indexPath), readFileSync(policyPath));
  writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
  const records = selectLocalInstallerEvidence(reportDirectory);
  if (records.length) process.stdout.write(records.join(','));
}
