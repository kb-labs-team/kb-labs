import { inflateRawSync } from 'node:zlib';

const workflowPath = '.github/workflows/release-build-candidate.yml';

const trustedRepository = 'kb-labs-team/kb-labs';

function extractReceiptFromZip(archive: Buffer): Buffer {
  let end = -1;
  const searchStart = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= searchStart; offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error('Trusted gate receipt artifact is not a valid ZIP archive');
  const entries = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index++) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Trusted gate receipt artifact has an invalid ZIP directory');
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (name === 'gate-attestation.json') {
      if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Trusted gate receipt artifact has an invalid ZIP entry');
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
      if (method === 0) return Buffer.from(compressed);
      if (method === 8) return inflateRawSync(compressed);
      throw new Error(`Trusted gate receipt artifact uses unsupported ZIP compression method ${method}`);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('Trusted candidate workflow artifact does not contain gate-attestation.json');
}

/** Verify receipt bytes came from the trusted candidate run's artifact. */
export async function authenticateCandidateGateReceipt({ repository, runId, candidateId, suppliedBytes, token }: {
  repository: string;
  runId: string;
  candidateId: string;
  suppliedBytes: Buffer;
  token: string;
}): Promise<void> {
  if (!/^[0-9]+$/.test(runId)) throw new Error('Candidate workflow run ID must contain digits only');
  if (repository.toLowerCase() !== trustedRepository) throw new Error(`Public candidate delivery is trusted only from ${trustedRepository}`);
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
  const artifactName = `release-gate-attestation-${candidateId}`;
  let page = 1;
  let artifact: { id: number; name: string; expired: boolean } | undefined;
  while (!artifact) {
    const artifactsResponse = await fetch(`${api}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`, { headers });
    if (!artifactsResponse.ok) throw new Error(`Could not list candidate workflow artifacts (${artifactsResponse.status})`);
    const artifacts = await artifactsResponse.json() as { artifacts?: Array<{ id: number; name: string; expired: boolean }>; total_count?: number };
    artifact = artifacts.artifacts?.find(item => item.name === artifactName && !item.expired);
    if (artifact || !artifacts.artifacts?.length || page * 100 >= (artifacts.total_count ?? artifacts.artifacts.length)) break;
    page++;
  }
  if (!artifact) throw new Error(`Trusted candidate workflow run is missing artifact ${artifactName}`);
  const archiveResponse = await fetch(`${api}/actions/artifacts/${artifact.id}/zip`, { headers });
  if (!archiveResponse.ok) throw new Error(`Could not download trusted gate receipt artifact (${archiveResponse.status})`);
  const artifactBytes = extractReceiptFromZip(Buffer.from(await archiveResponse.arrayBuffer()));
  if (!artifactBytes.equals(suppliedBytes)) {
    throw new Error('Supplied gate receipt bytes differ from the trusted candidate workflow artifact');
  }
}
