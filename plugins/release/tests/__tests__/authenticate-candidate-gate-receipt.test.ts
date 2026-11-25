import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { authenticateCandidateGateReceipt } from '../../src/shared/authenticate-candidate-gate-receipt.js';

let root = '';
afterEach(() => {
  vi.unstubAllGlobals();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('candidate gate receipt source authentication', () => {
  it('accepts bytes only when they match the receipt artifact from the trusted completed workflow run', async () => {
    root = mkdtempSync(join(tmpdir(), 'kb-gate-receipt-test-'));
    const artifactDir = join(root, 'artifact');
    mkdirSync(artifactDir);
    const receipt = Buffer.from('{"schema":"kb.release-gate-attestation/1","result":"passed"}\n');
    writeFileSync(join(artifactDir, 'gate-attestation.json'), receipt);
    const archive = join(root, 'artifact.zip');
    execFileSync('zip', ['-q', '-r', archive, 'gate-attestation.json'], { cwd: artifactDir });
    const archiveBytes = readFileSync(archive);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/actions/runs/123')) return Response.json({
        path: '.github/workflows/release-build-candidate.yml', event: 'workflow_dispatch',
        status: 'completed', conclusion: 'success', head_branch: 'master',
        head_repository: { full_name: 'kb-labs-team/kb-labs' },
      });
      if (url.includes('/actions/runs/123/artifacts?')) return Response.json({
        artifacts: [{ id: 456, name: 'release-gate-attestation-candidate-1', expired: false }],
      });
      if (url.endsWith('/actions/artifacts/456/zip')) return new Response(archiveBytes);
      return new Response('', { status: 404 });
    }));
    const args = { repository: 'kb-labs-team/kb-labs', runId: '123', candidateId: 'candidate-1', suppliedBytes: receipt, token: 'test-token' };
    await expect(authenticateCandidateGateReceipt(args)).resolves.toBeUndefined();
    await expect(authenticateCandidateGateReceipt({ ...args, suppliedBytes: Buffer.from(`${receipt.toString()} `) }))
      .rejects.toThrow(/differ from the trusted candidate workflow artifact/);
    await expect(authenticateCandidateGateReceipt({ ...args, repository: 'attacker/repo' }))
      .rejects.toThrow(/trusted only from kb-labs-team\/kb-labs/);
  });
});
