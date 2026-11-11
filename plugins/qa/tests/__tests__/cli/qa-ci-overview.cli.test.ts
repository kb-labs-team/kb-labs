import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import command from '../../../src/cli/commands/qa-ci-overview.js';

const dirs: string[] = [];

function writeDossier(): string {
  const dir = join(tmpdir(), `qa-ci-overview-${Date.now()}-${Math.random()}`);
  dirs.push(dir);
  mkdirSync(join(dir, '123'), { recursive: true });
  writeFileSync(join(dir, '123', 'dossier.json'), JSON.stringify({
    schemaVersion: 1, provider: 'github-actions', collectedAt: '2026-07-26T10:00:00.000Z', collectionStatus: 'complete',
    run: { id: '123', attempt: 1, event: 'push', status: 'completed', conclusion: 'failure', startedAt: null, completedAt: null, headSha: 'abc', headBranch: 'main', htmlUrl: 'https://example.test/run' },
    workflow: { name: 'E2E Platform Tests' }, sourceRefs: [],
    jobs: [{ id: '1', name: 'E2E / mcp', conclusion: 'failure', startedAt: null, completedAt: null, durationMs: null, htmlUrl: 'https://example.test/job', steps: [], failure: { phase: 'setup', fingerprint: 'network.registry.docker-hub-timeout', summary: 'Docker Hub timed out', confidence: 0.95 } }],
  }));
  return dir;
}

afterEach(() => { for (const dir of dirs.splice(0)) {rmSync(dir, { recursive: true, force: true });} });

describe('qa:ci-overview', () => {
  it('renders a compact ctx.ui summary for a person by default', async () => {
    const { ui, captured } = createCapturedUI();
    const result = await command.execute(createMockContext({ ui, cwd: '/' }) as never, mockCLIInput({ flags: { input: writeDossier() } }) as never);
    expect(result).not.toHaveProperty('ok');
    expect(captured.success[0]?.message).toContain('CI reliability');
    expect(captured.json).toHaveLength(0);
  });

  it('emits the same compact contract for agents with --json', async () => {
    const { ui, captured } = createCapturedUI();
    const result = await command.execute(createMockContext({ ui, cwd: '/' }) as never, mockCLIInput({ flags: { input: writeDossier(), json: true } }) as never);
    expect(result).toMatchObject({ runsAnalyzed: 1, findings: [{ fingerprint: 'network.registry.docker-hub-timeout' }] });
  });
});
