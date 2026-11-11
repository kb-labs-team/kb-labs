import type { CiReliabilityFinding, CiReliabilityOverview, CiRunDossier } from '../../contracts/index.js';

export function analyzeCiReliability(dossiers: CiRunDossier[]): CiReliabilityOverview {
  const findings = new Map<string, CiReliabilityFinding>();
  let failedRuns = 0;
  let failedBeforeTests = 0;
  let complete = 0;
  for (const dossier of dossiers) {
    if (dossier.collectionStatus === 'complete') {complete++;}
    const failures = dossier.jobs.filter(job => job.failure);
    if (failures.length > 0) {failedRuns++;}
    if (failures.some(job => job.failure?.phase !== 'test')) {failedBeforeTests++;}
    for (const job of failures) {
      const failure = job.failure!;
      const existing = findings.get(failure.fingerprint);
      if (existing) {
        existing.occurrences++;
        existing.affectedJobs = unique([...existing.affectedJobs, job.name]);
        existing.sampleRunIds = unique([...existing.sampleRunIds, dossier.run.id]).slice(-5);
        existing.lastSeenAt = dossier.collectedAt;
        existing.confidence = Math.max(existing.confidence, failure.confidence);
      } else {
        findings.set(failure.fingerprint, {
          fingerprint: failure.fingerprint, phase: failure.phase, summary: failure.summary,
          confidence: failure.confidence, occurrences: 1, affectedJobs: [job.name],
          sampleRunIds: [dossier.run.id], firstSeenAt: dossier.collectedAt, lastSeenAt: dossier.collectedAt,
        });
      }
    }
  }
  const ordered = [...findings.values()].sort((a, b) => b.occurrences - a.occurrences || b.confidence - a.confidence);
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), runsAnalyzed: dossiers.length,
    failedRuns, failedBeforeTests, collection: { complete, partial: dossiers.length - complete },
    findings: ordered, drillDown: { runIds: unique(ordered.flatMap(finding => finding.sampleRunIds)) },
  };
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
