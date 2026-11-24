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
    profile: { os: 'linux', runtime: `node-${nodeMajor}`, surface: 'cli' },
  };
}

export function selectLocalInstallerEvidence(reportDirectory) {
  const candidates = readdirSync(reportDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith('installer-case-local-') && entry.name.endsWith('.json'))
    .map((entry) => join(reportDirectory, entry.name));
  const records = [];
  const invalid = [];
  for (const path of candidates) {
      try {
        const wrapper = JSON.parse(readFileSync(path, 'utf8'));
        const run = wrapper?.case_run;
        if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)
          || !run || typeof run !== 'object' || Array.isArray(run)
          || run.mode !== 'local' || !Array.isArray(run.claims)
          || (run.selection !== undefined && (!Array.isArray(run.selection)
            || !run.selection.every((item) => typeof item === 'string')))) {
          invalid.push({ path, reason: 'local installer wrapper has an invalid case_run envelope' });
          continue;
        }
        const claim = run?.claims?.find((item) => item.claimId === 'PC-001.2');
        const selectedTarget = claim || run.selection?.includes('PC-001.2');
        if (selectedTarget) {
          if (run.schema === 'kb.qa-case-run/v3' && (claim?.status === 'PASS' || claim?.status === 'FAIL')) {
            records.push({ path, behaviorStatus: claim.status });
          } else {
            invalid.push({ path, reason: 'selected PC-001.2 evidence must be a v3 run with a PASS or FAIL claim' });
          }
        }
      } catch (error) {
        invalid.push({ path, reason: error instanceof Error ? error.message : String(error) });
      }
  }
  const orphanedEvidence = records.length === 0 ? findUnboundPC001Evidence(reportDirectory) : [];
  return { records, invalid, orphanedEvidence };
}

function findUnboundPC001Evidence(reportDirectory) {
  const evidenceRoot = join(reportDirectory, 'qa-evidence');
  const found = [];
  const visit = (directory) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && (entry.name === 'step-PC-001.2.log'
        || entry.name === 'redacted-platform-config.jsonc'
        || entry.name === 'redacted-config.jsonc')) {
        found.push(path.slice(reportDirectory.length + 1));
      }
    }
  };
  visit(evidenceRoot);
  return found.sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [indexPath, policyPath, outputPath, reportDirectory, manifestPath] = process.argv.slice(2);
  if (!indexPath || !policyPath || !outputPath || !reportDirectory || !manifestPath) throw new Error('usage: node installer-evidence-plan.mjs <release-index.json> <node-policy.json> <plan.json> <reports-dir> <manifest.json>');
  writeFileSync(manifestPath, `${JSON.stringify(selectLocalInstallerEvidence(reportDirectory), null, 2)}\n`);
  if (indexPath !== '-') {
    const plan = evidencePlan(readFileSync(indexPath), readFileSync(policyPath));
    writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
  }
}
