import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflowPath = '.github/workflows/release-build-candidate.yml';

/** Verify the receipt bytes came from the trusted candidate run's artifact. */
export async function authenticateCandidateGateReceipt({ repository, runId, candidateId, receiptPath, token }: {
  repository: string;
  runId: string;
  candidateId: string;
  receiptPath: string;
  token: string;
}): Promise<void> {
  if (!/^[0-9]+$/.test(runId)) throw new Error('Candidate workflow run ID must contain digits only');
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
  const api = `https://api.github.com/repos/${repository}`;
  const runResponse = await fetch(`${api}/actions/runs/${runId}`, { headers });
  if (!runResponse.ok) throw new Error(`Could not verify candidate workflow run (${runResponse.status})`);
  const run = await runResponse.json() as {
    path?: string; event?: string; status?: string; conclusion?: string; head_branch?: string;
    head_repository?: { full_name?: string };
  };
  const [path, ref] = (run.path ?? '').split('@', 2);
  if (path !== workflowPath || (ref !== undefined && ref !== 'master' && ref !== 'refs/heads/master')
    || run.event !== 'workflow_dispatch' || run.status !== 'completed' || run.conclusion !== 'success'
    || run.head_branch !== 'master' || run.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('Candidate gate receipt did not come from a successful trusted release-build-candidate workflow run');
  }
  const artifactsResponse = await fetch(`${api}/actions/runs/${runId}/artifacts`, { headers });
  if (!artifactsResponse.ok) throw new Error(`Could not list candidate workflow artifacts (${artifactsResponse.status})`);
  const artifacts = await artifactsResponse.json() as { artifacts?: Array<{ id: number; name: string; expired: boolean }> };
  const artifactName = `release-gate-attestation-${candidateId}`;
  const artifact = artifacts.artifacts?.find(item => item.name === artifactName && !item.expired);
  if (!artifact) throw new Error(`Trusted candidate workflow run is missing artifact ${artifactName}`);
  const archiveResponse = await fetch(`${api}/actions/artifacts/${artifact.id}/zip`, { headers });
  if (!archiveResponse.ok) throw new Error(`Could not download trusted gate receipt artifact (${archiveResponse.status})`);

  const temp = mkdtempSync(join(tmpdir(), 'kb-gate-receipt-'));
  try {
    const archive = join(temp, 'receipt.zip');
    writeFileSync(archive, Buffer.from(await archiveResponse.arrayBuffer()));
    const artifactBytes = execFileSync('unzip', ['-p', archive, 'gate-attestation.json']);
    const suppliedBytes = readFileSync(receiptPath);
    if (!artifactBytes.equals(suppliedBytes)) {
      throw new Error('Supplied gate receipt bytes differ from the trusted candidate workflow artifact');
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
