import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/index.js', () => ({
  analyzeLayering: vi.fn().mockResolvedValue({ totalViolations: 0, violations: [] }),
  analyzeCoupling: vi.fn().mockReturnValue({ packages: [], avgInstability: 0 }),
  runKnip: vi.fn().mockResolvedValue({ unusedFiles: [], unusedExports: [], unusedDependencies: [], unlistedDependencies: [], totalIssues: 0 }),
  analyzeTypes: vi.fn().mockResolvedValue({ packages: [] }),
  QualitySnapshotStore: class {
    save() { return { score: 90, grade: 'A', dimensions: {}, git: {} }; }
  },
  calculateHealth: vi.fn().mockReturnValue({
    score: 90,
    grade: 'A',
    dimensions: {},
  }),
}));

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    useConfig: vi.fn().mockResolvedValue(null),
  };
});

import { analyzeLayering, analyzeCoupling, runKnip, analyzeTypes, calculateHealth } from '../../../src/core/index.js';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import snapshotCommand from '../../../src/cli/commands/snapshot.js';

interface SnapshotFlags {
  json?: boolean;
  'dry-run'?: boolean;
}

const mockSnap = {
  id: 'snapshot-test',
  timestamp: '2026-01-01T00:00:00.000Z',
  score: 90,
  grade: 'A' as const,
  dimensions: {
    architecture: { score: 90, grade: 'A' as const, details: [] },
    typescript: { score: 90, grade: 'A' as const, details: [] },
    deadCode: { score: 90, grade: 'A' as const, details: [] },
    depHygiene: { score: 90, grade: 'A' as const, details: [] },
    testCoverage: { score: 90, grade: 'A' as const, details: [] },
  },
  git: { commit: 'test', branch: 'test', message: 'test' },
  counters: { layeringViolations: 0, avgInstability: 0, anyCount: 0, tsIgnoreCount: 0, unusedFiles: 0, unusedDeps: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(analyzeLayering).mockResolvedValue({ totalViolations: 0, violations: [] } as never);
  vi.mocked(analyzeCoupling).mockReturnValue({ packages: [], avgInstability: 0 } as never);
  vi.mocked(runKnip).mockResolvedValue({ unusedFiles: [], unusedExports: [], unusedDependencies: [], unlistedDependencies: [], totalIssues: 0 });
  vi.mocked(analyzeTypes).mockResolvedValue({ packages: [] } as never);
  vi.mocked(calculateHealth).mockReturnValue({ score: 90, grade: 'A', dimensions: {} } as never);
});

describe('quality:snapshot', () => {
  it('QSNAP-01: collects metrics and saves snapshot', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await snapshotCommand.execute(ctx as never, mockCLIInput<SnapshotFlags>());

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('QSNAP-02: --json outputs snapshot data', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await snapshotCommand.execute(ctx as never, mockCLIInput<SnapshotFlags>({ flags: { json: true } }));

    expect((result as typeof mockSnap).score).toBe(90);
    expect(captured.json).toHaveLength(0);
  });

  it('QSNAP-03: --dry-run shows intent, no metrics collected', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await snapshotCommand.execute(ctx as never, mockCLIInput<SnapshotFlags>({ flags: { 'dry-run': true } }));

    expect(result).not.toHaveProperty('ok');
    expect(analyzeLayering).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });
});
