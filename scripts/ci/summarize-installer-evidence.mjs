import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function summarizeInstallerEvidence(evaluation, manifest) {
  const records = Array.isArray(manifest?.records) ? manifest.records : [];
  const invalidRecords = Array.isArray(manifest?.invalid) ? manifest.invalid : [];
  const orphanedEvidenceArtifacts = Array.isArray(manifest?.orphanedEvidence) ? manifest.orphanedEvidence : [];
  const coverage = evaluation?.data ?? evaluation;
  const targetCase = coverage?.cases?.find((item) => item.id === 'PC-001');
  const targetStep = targetCase?.steps?.find((step) => step.stepId === 'PC-001.2');
  const incomplete = records.length === 0 || invalidRecords.length > 0
    || coverage?.schema !== 'kb.qa-case-coverage/v2' || !targetStep
    || targetStep.evidenceStatus !== 'COMPLETE';
  const observedBehaviorStatuses = [...new Set(records.map((record) => record.behaviorStatus)
    .filter((status) => status === 'PASS' || status === 'FAIL'))];
  const behaviorStatus = targetStep?.status
    ?? (observedBehaviorStatuses.includes('FAIL') ? 'FAIL'
      : observedBehaviorStatuses.includes('PASS') ? 'PASS'
        : orphanedEvidenceArtifacts.length > 0 ? 'NOT RECORDED' : 'NOT RUN');
  const reason = records.length === 0 && orphanedEvidenceArtifacts.length > 0
    ? 'PC-001.2 artifacts were retained without a valid case-run record; behavior cannot be determined from artifacts alone.'
    : !coverage || coverage.schema !== 'kb.qa-case-coverage/v2'
      ? 'Evidence evaluation output is missing or invalid.'
      : targetStep?.reason;
  return {
    status: incomplete ? 'INCOMPLETE' : behaviorStatus,
    behaviorStatus,
    evidenceStatus: incomplete ? 'INCOMPLETE' : targetStep.evidenceStatus,
    releasePassed: !incomplete && coverage.releasePassed === true,
    selectedRunRecords: records.map((record) => record.path),
    observedBehaviorStatuses,
    invalidRunRecords: invalidRecords,
    orphanedEvidenceArtifacts,
    ...(reason ? { reason } : {}),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [evaluationPath, manifestPath, outputPath] = process.argv.slice(2);
  if (!evaluationPath || !manifestPath || !outputPath) throw new Error('usage: node summarize-installer-evidence.mjs <evaluation.json> <manifest.json> <summary.json>');
  let evaluation;
  if (evaluationPath !== '-') {
    try { evaluation = JSON.parse(readFileSync(evaluationPath, 'utf8')); } catch { evaluation = undefined; }
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const summary = summarizeInstallerEvidence(evaluation, manifest);
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
}
