import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function summarizeInstallerEvidence(evaluation, manifest) {
  const records = Array.isArray(manifest?.records) ? manifest.records : [];
  const invalidRecords = Array.isArray(manifest?.invalid) ? manifest.invalid : [];
  const targetCase = evaluation?.cases?.find((item) => item.id === 'PC-001');
  const targetStep = targetCase?.steps?.find((step) => step.stepId === 'PC-001.2');
  const incomplete = records.length === 0 || invalidRecords.length > 0
    || evaluation?.schema !== 'kb.qa-case-coverage/v2' || !targetStep
    || targetStep.evidenceStatus !== 'COMPLETE';
  return {
    status: incomplete ? 'INCOMPLETE' : targetStep.status,
    behaviorStatus: targetStep?.status ?? 'NOT RUN',
    evidenceStatus: targetStep?.evidenceStatus ?? 'INCOMPLETE',
    ...(typeof evaluation?.releasePassed === 'boolean' ? { releasePassed: evaluation.releasePassed } : { releasePassed: false }),
    selectedRunRecords: records,
    invalidRunRecords: invalidRecords,
    ...(!evaluation || evaluation.schema !== 'kb.qa-case-coverage/v2'
      ? { reason: 'Evidence evaluation output is missing or invalid.' } : {}),
    ...(targetStep?.reason ? { reason: targetStep.reason } : {}),
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
