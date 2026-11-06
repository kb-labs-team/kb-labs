import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RunMetricsEmitter,
  getKpiBaselineKey,
  detectQualityRegression,
  updateKpiBaseline,
  extractToolErrorCode,
  clearProcessKpiBaselines,
} from '../../src/core/analytics/run-metrics-emitter';
import type {
  KpiBaseline,
  RegressionMetrics,
  EmitContext,
  RunKpiPayload,
} from '../../src/core/analytics/run-metrics-emitter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseline(overrides: Partial<KpiBaseline> = {}): KpiBaseline {
  return {
    driftRateEma: 0.05,
    evidenceDensityEma: 1.5,
    toolErrorRateEma: 0.1,
    samples: 5,
    tokenHistory: [100, 200, 300],
    iterationUtilizationHistory: [0.5, 0.6],
    qualityScoreHistory: [0.9, 0.8],
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<RegressionMetrics> = {}): RegressionMetrics {
  return {
    driftRate: 0.05,
    evidenceDensity: 1.5,
    toolErrorRate: 0.1,
    tokensUsed: 500,
    iterationsUsed: 5,
    iterationBudget: 10,
    iterationUtilization: 0.5,
    qualityScore: 0.9,
    qualityGateStatus: 'pass',
    ...overrides,
  };
}

function makeAnalytics() {
  return { track: vi.fn().mockResolvedValue(undefined) };
}

function makeEmitCtx(overrides: Partial<EmitContext> = {}): EmitContext {
  return {
    analytics: makeAnalytics(),
    baselineKey: 'test::agent',
    log: vi.fn(),
    ...overrides,
  };
}

function makeKpiPayload(overrides: Partial<RunKpiPayload> = {}): RunKpiPayload {
  return {
    agentId: 'agent-1',
    task: 'test task',
    success: true,
    summaryPreview: 'done',
    iterationsUsed: 5,
    iterationBudget: 10,
    startTier: 'small',
    finalTier: 'small',
    durationMs: 1000,
    tokensUsed: 500,
    toolCallsTotal: 10,
    toolSuccessCount: 8,
    toolErrorCount: 2,
    todoToolCalls: 1,
    filesReadCount: 3,
    filesModifiedCount: 1,
    filesCreatedCount: 0,
    driftDomainCount: 2,
    driftDomains: ['domain1', 'domain2'],
    executionPhase: 'executing',
    phaseDurationsMs: { executing: 1000 },
    phaseTransitionCount: 1,
    phaseTransitions: [],
    ledger: { failedSteps: 0, pendingSteps: 0 },
    qualityGate: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure: getKpiBaselineKey
// ---------------------------------------------------------------------------

describe('getKpiBaselineKey', () => {
  it('uses sessionRootDir when available', () => {
    expect(getKpiBaselineKey('/sessions/root', '/work')).toBe('/sessions/root::agent');
  });

  it('falls back to workingDir', () => {
    expect(getKpiBaselineKey('', '/work')).toBe('/work::agent');
  });

  it('falls back to workspace when both empty', () => {
    expect(getKpiBaselineKey('', '')).toBe('workspace::agent');
  });
});

// ---------------------------------------------------------------------------
// Pure: extractToolErrorCode
// ---------------------------------------------------------------------------

describe('extractToolErrorCode', () => {
  it('extracts from errorDetails.code', () => {
    expect(
      extractToolErrorCode({
        success: false,
        errorDetails: { code: 'ENOENT', retryable: false },
      }),
    ).toBe('ENOENT');
  });

  it('extracts from metadata.errorCode', () => {
    expect(
      extractToolErrorCode({
        success: false,
        metadata: { errorCode: 'TIMEOUT' },
      }),
    ).toBe('TIMEOUT');
  });

  it('extracts from error string prefix', () => {
    expect(
      extractToolErrorCode({
        success: false,
        error: 'ENOENT: no such file',
      }),
    ).toBe('ENOENT');
  });

  it('returns null when no code found', () => {
    expect(
      extractToolErrorCode({
        success: false,
        error: 'something went wrong',
      }),
    ).toBeNull();
  });

  it('returns null for success with no details', () => {
    expect(extractToolErrorCode({ success: true })).toBeNull();
  });

  it('ignores blank metadata.errorCode', () => {
    expect(
      extractToolErrorCode({
        success: false,
        metadata: { errorCode: '  ' },
      }),
    ).toBeNull();
  });

  it('prefers errorDetails.code over metadata', () => {
    expect(
      extractToolErrorCode({
        success: false,
        errorDetails: { code: 'A' },
        metadata: { errorCode: 'B' },
      }),
    ).toBe('A');
  });
});

// ---------------------------------------------------------------------------
// Pure: detectQualityRegression
// ---------------------------------------------------------------------------

describe('detectQualityRegression', () => {
  it('does not regress with too few samples', () => {
    const baseline = makeBaseline({ samples: 2 });
    const metrics = makeMetrics({ driftRate: 1.0 });
    const result = detectQualityRegression(metrics, baseline);
    expect(result.regressed).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('detects drift rate regression', () => {
    const baseline = makeBaseline({ driftRateEma: 0.05 });
    const metrics = makeMetrics({ driftRate: 0.2 });
    const result = detectQualityRegression(metrics, baseline);
    expect(result.regressed).toBe(true);
    expect(result.reasons).toContain('drift_rate_regressed');
  });

  it('detects evidence density regression', () => {
    const baseline = makeBaseline({ evidenceDensityEma: 2.0 });
    const metrics = makeMetrics({ evidenceDensity: 1.5 });
    const result = detectQualityRegression(metrics, baseline);
    expect(result.regressed).toBe(true);
    expect(result.reasons).toContain('evidence_density_regressed');
  });

  it('detects tool error rate regression', () => {
    const baseline = makeBaseline({ toolErrorRateEma: 0.1 });
    const metrics = makeMetrics({ toolErrorRate: 0.3 });
    const result = detectQualityRegression(metrics, baseline);
    expect(result.regressed).toBe(true);
    expect(result.reasons).toContain('tool_error_rate_regressed');
  });

  it('detects partial quality near budget limit', () => {
    const baseline = makeBaseline();
    const metrics = makeMetrics({
      qualityGateStatus: 'partial',
      iterationsUsed: 10,
      iterationBudget: 10,
    });
    const result = detectQualityRegression(metrics, baseline);
    expect(result.regressed).toBe(true);
    expect(result.reasons).toContain('partial_quality_near_budget_limit');
  });

  it('does not regress when metrics are within thresholds', () => {
    const baseline = makeBaseline();
    const metrics = makeMetrics();
    const result = detectQualityRegression(metrics, baseline);
    expect(result.regressed).toBe(false);
  });

  it('can detect multiple regressions at once', () => {
    const baseline = makeBaseline({ driftRateEma: 0.05, toolErrorRateEma: 0.1 });
    const metrics = makeMetrics({ driftRate: 0.2, toolErrorRate: 0.3 });
    const result = detectQualityRegression(metrics, baseline);
    expect(result.reasons).toContain('drift_rate_regressed');
    expect(result.reasons).toContain('tool_error_rate_regressed');
  });
});

// ---------------------------------------------------------------------------
// Pure: updateKpiBaseline
// ---------------------------------------------------------------------------

describe('updateKpiBaseline', () => {
  it('initializes EMA on first sample', () => {
    const baseline = makeBaseline({ samples: 0 });
    const metrics = makeMetrics({ driftRate: 0.1, evidenceDensity: 2.0, toolErrorRate: 0.05 });
    const updated = updateKpiBaseline(baseline, metrics);
    expect(updated.driftRateEma).toBe(0.1);
    expect(updated.evidenceDensityEma).toBe(2.0);
    expect(updated.toolErrorRateEma).toBe(0.05);
    expect(updated.samples).toBe(1);
  });

  it('applies EMA on subsequent samples', () => {
    const baseline = makeBaseline({ driftRateEma: 0.1, samples: 3 });
    const metrics = makeMetrics({ driftRate: 0.2 });
    const updated = updateKpiBaseline(baseline, metrics, 0.25);
    // EMA: 0.1 * 0.75 + 0.2 * 0.25 = 0.075 + 0.05 = 0.125
    expect(updated.driftRateEma).toBeCloseTo(0.125);
  });

  it('appends to token history', () => {
    const baseline = makeBaseline({ tokenHistory: [100, 200] });
    const metrics = makeMetrics({ tokensUsed: 300 });
    const updated = updateKpiBaseline(baseline, metrics);
    expect(updated.tokenHistory).toEqual([100, 200, 300]);
  });

  it('caps history at 50 items', () => {
    const baseline = makeBaseline({ tokenHistory: Array.from({ length: 50 }, (_, i) => i) });
    const metrics = makeMetrics({ tokensUsed: 999 });
    const updated = updateKpiBaseline(baseline, metrics);
    expect(updated.tokenHistory).toHaveLength(50);
    expect(updated.tokenHistory[49]).toBe(999);
    expect(updated.tokenHistory[0]).toBe(1);
  });

  it('increments sample count', () => {
    const baseline = makeBaseline({ samples: 10 });
    const updated = updateKpiBaseline(baseline, makeMetrics());
    expect(updated.samples).toBe(11);
  });

  it('appends to iterationUtilizationHistory', () => {
    const baseline = makeBaseline({ iterationUtilizationHistory: [0.5] });
    const metrics = makeMetrics({ iterationUtilization: 0.7 });
    const updated = updateKpiBaseline(baseline, metrics);
    expect(updated.iterationUtilizationHistory).toEqual([0.5, 0.7]);
  });

  it('appends to qualityScoreHistory', () => {
    const baseline = makeBaseline({ qualityScoreHistory: [0.9] });
    const metrics = makeMetrics({ qualityScore: 0.8 });
    const updated = updateKpiBaseline(baseline, metrics);
    expect(updated.qualityScoreHistory).toEqual([0.9, 0.8]);
  });
});

// ---------------------------------------------------------------------------
// Class: RunMetricsEmitter
// ---------------------------------------------------------------------------

describe('RunMetricsEmitter', () => {
  beforeEach(() => {
    clearProcessKpiBaselines();
  });

  describe('recordTierEscalation', () => {
    it('pushes escalation to array', async () => {
      const emitter = new RunMetricsEmitter();
      await emitter.recordTierEscalation('small', 'medium', 'stuck', 3, {
        analytics: null,
        agentId: 'a',
        task: 't',
        tierEscalatedEvent: 'event',
        log: vi.fn(),
      });
      expect(emitter.tierEscalations).toEqual([
        { from: 'small', to: 'medium', reason: 'stuck', iteration: 3 },
      ]);
    });

    it('emits analytics event when analytics available', async () => {
      const emitter = new RunMetricsEmitter();
      const analytics = makeAnalytics();
      await emitter.recordTierEscalation('small', 'medium', 'stuck', 3, {
        analytics,
        sessionId: 's1',
        agentId: 'a',
        task: 't',
        tierEscalatedEvent: 'tier.escalated',
        log: vi.fn(),
      });
      expect(analytics.track).toHaveBeenCalledWith('tier.escalated', expect.objectContaining({
        fromTier: 'small',
        toTier: 'medium',
        reason: 'stuck',
      }));
    });

    it('silently handles analytics error', async () => {
      const emitter = new RunMetricsEmitter();
      const analytics = { track: vi.fn().mockRejectedValue(new Error('fail')) };
      const log = vi.fn();
      await emitter.recordTierEscalation('small', 'medium', 'stuck', 3, {
        analytics,
        agentId: 'a',
        task: 't',
        tierEscalatedEvent: 'event',
        log,
      });
      // Should not throw
      expect(emitter.tierEscalations).toHaveLength(1);
    });
  });

  describe('trackToolOutcome', () => {
    it('skips when no analytics', () => {
      const emitter = new RunMetricsEmitter();
      emitter.trackToolOutcome(
        { toolName: 'grep_search', success: true, durationMs: 100 },
        { analytics: null, toolCalledEvent: 'tool.called', log: vi.fn() },
      );
      // No throw
    });

    it('fires event when analytics available', () => {
      const emitter = new RunMetricsEmitter();
      const analytics = makeAnalytics();
      emitter.trackToolOutcome(
        { toolName: 'grep_search', success: false, durationMs: 50, errorCode: 'TIMEOUT' },
        { analytics, toolCalledEvent: 'tool.called', log: vi.fn() },
      );
      expect(analytics.track).toHaveBeenCalledWith('tool.called', {
        toolName: 'grep_search',
        success: false,
        durationMs: 50,
        errorCode: 'TIMEOUT',
        retryable: undefined,
      });
    });
  });

  describe('emitRunKpis', () => {
    it('skips when no analytics', async () => {
      const emitter = new RunMetricsEmitter();
      const ctx = makeEmitCtx({ analytics: null });
      await emitter.emitRunKpis(makeKpiPayload(), ctx);
      // Should not throw
    });

    it('fires run_completed event', async () => {
      const emitter = new RunMetricsEmitter();
      const ctx = makeEmitCtx();
      await emitter.emitRunKpis(makeKpiPayload(), ctx);
      expect(ctx.analytics!.track).toHaveBeenCalledWith(
        'agent.kpi.run_completed',
        expect.objectContaining({ agentId: 'agent-1' }),
      );
    });

    it('calculates derived metrics correctly', async () => {
      const emitter = new RunMetricsEmitter();
      const ctx = makeEmitCtx();
      await emitter.emitRunKpis(
        makeKpiPayload({
          toolCallsTotal: 10,
          toolErrorCount: 3,
          driftDomainCount: 3,
          filesReadCount: 4,
          filesModifiedCount: 2,
          filesCreatedCount: 1,
          iterationsUsed: 7,
          iterationBudget: 10,
        }),
        ctx,
      );
      const trackFn = ctx.analytics!.track as ReturnType<typeof vi.fn>;
      // Find the run_completed call (emitQualityRegressionEvent may or may not fire first)
      const runCompletedCall = trackFn.mock.calls.find(
        (call: unknown[]) => call[0] === 'agent.kpi.run_completed',
      );
      expect(runCompletedCall).toBeDefined();
      const payload = runCompletedCall![1] as Record<string, unknown>;
      expect(payload.toolErrorRate).toBeCloseTo(0.3);
      expect(payload.iterationUtilization).toBeCloseTo(0.7);
      expect(payload.evidenceDensity).toBe(1); // (4+2+1)/7 = 1
      expect(payload.driftRate).toBeCloseTo(0.2); // (3-1)/10 = 0.2
    });
  });

  describe('reset', () => {
    it('clears tier escalations', async () => {
      const emitter = new RunMetricsEmitter();
      await emitter.recordTierEscalation('small', 'medium', 'stuck', 3, {
        analytics: null,
        agentId: 'a',
        task: 't',
        tierEscalatedEvent: 'event',
        log: vi.fn(),
      });
      expect(emitter.tierEscalations).toHaveLength(1);
      emitter.reset();
      expect(emitter.tierEscalations).toHaveLength(0);
    });
  });
});
