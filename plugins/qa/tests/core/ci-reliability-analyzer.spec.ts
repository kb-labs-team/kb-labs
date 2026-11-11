import { describe, expect, it } from 'vitest';
import { analyzeCiReliability } from '../../src/core/ci/reliability-analyzer.js';
import type { CiRunDossier } from '@kb-labs/qa/contracts';

function dossier(id: string, fingerprint?: string, phase: 'setup' | 'test' = 'setup'): CiRunDossier {
  return {
    schemaVersion: 1, provider: 'github-actions', collectedAt: `2026-07-2${id}T10:00:00.000Z`, collectionStatus: 'complete',
    run: { id, attempt: 1, event: 'push', status: 'completed', conclusion: fingerprint ? 'failure' : 'success', startedAt: null, completedAt: null, headSha: 'abc', headBranch: 'main', htmlUrl: `https://example.test/runs/${id}` },
    workflow: { name: 'E2E Platform Tests' }, sourceRefs: [],
    jobs: [{ id: `job-${id}`, name: 'E2E / mcp', conclusion: fingerprint ? 'failure' : 'success', startedAt: null, completedAt: null, durationMs: null, htmlUrl: 'https://example.test/job', steps: [], failure: fingerprint ? { phase, fingerprint, summary: 'failure', confidence: 0.9 } : undefined }],
  };
}

describe('analyzeCiReliability', () => {
  it('groups failures by fingerprint and keeps evidence references compact', () => {
    const overview = analyzeCiReliability([
      dossier('1', 'network.registry.docker-hub-timeout'),
      dossier('2', 'network.registry.docker-hub-timeout'),
      dossier('3', 'test.failure.unclassified', 'test'),
    ]);
    expect(overview.runsAnalyzed).toBe(3);
    expect(overview.failedBeforeTests).toBe(2);
    expect(overview.findings[0]).toMatchObject({ fingerprint: 'network.registry.docker-hub-timeout', occurrences: 2, sampleRunIds: ['1', '2'] });
    expect(JSON.stringify(overview)).not.toContain('htmlUrl');
  });

  it('reports an empty, successful evidence set without inventing findings', () => {
    const overview = analyzeCiReliability([dossier('1')]);
    expect(overview.failedRuns).toBe(0);
    expect(overview.findings).toEqual([]);
  });
});
