import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function persistFailureEvidence(outPath, verdict, failedJobs, structuredArtifacts = []) {
  const evidenceDirectory = `${outPath}.failed-logs`;
  const relativeDirectory = path.basename(evidenceDirectory);
  const jobsByName = new Map(failedJobs.map((job, index) => [job.name, { ...job, index }]));
  const failed = verdict.jobs.map((job, index) => {
    if (job.status === 'pass') return job;
    const evidence = jobsByName.get(job.name) ?? { index };
    const logPath = path.join(relativeDirectory, `job-${String(evidence.index + 1).padStart(3, '0')}.log`);
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(path.join(path.dirname(outPath), logPath), evidence.log ?? job.logTail ?? '', 'utf8');
    const { logTail: _logTail, ...rest } = job;
    return { ...rest, evidence: { ...(job.evidence ?? {}), logPath } };
  });
  const persistedArtifacts = structuredArtifacts.map((artifact, index) => {
    mkdirSync(evidenceDirectory, { recursive: true });
    const relativePath = path.join(relativeDirectory, `structured-${String(index + 1).padStart(3, '0')}.json`);
    writeFileSync(path.join(path.dirname(outPath), relativePath), artifact.content, 'utf8');
    return { name: artifact.name, path: relativePath };
  });
  const { failureEvidence: _failureEvidence, ...cleanVerdict } = verdict;
  return {
    ...cleanVerdict,
    jobs: failed,
    ...(persistedArtifacts.length ? { structuredFindings: persistedArtifacts } : {}),
  };
}
