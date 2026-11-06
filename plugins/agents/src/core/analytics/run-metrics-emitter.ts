/**
 * Run Metrics Emitter
 *
 * Fires analytics events for run KPIs, tool outcomes, tier escalations,
 * and detects quality regressions using EMA baselines.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KpiBaseline {
  driftRateEma: number;
  evidenceDensityEma: number;
  toolErrorRateEma: number;
  samples: number;
  tokenHistory: number[];
  iterationUtilizationHistory: number[];
  qualityScoreHistory: number[];
}

export interface TierEscalation {
  from: string;
  to: string;
  reason: string;
  iteration: number;
}

export interface RegressionMetrics {
  driftRate: number;
  evidenceDensity: number;
  toolErrorRate: number;
  tokensUsed: number;
  iterationsUsed: number;
  iterationBudget: number;
  iterationUtilization: number;
  qualityScore: number;
  qualityGateStatus: string;
}

export interface RunKpiPayload {
  sessionId?: string;
  agentId: string;
  task: string;
  success: boolean;
  error?: string;
  summaryPreview: string;
  iterationsUsed: number;
  iterationBudget: number;
  tokenBudget?: number;
  tokenUtilization?: number;
  startTier: string;
  finalTier: string;
  durationMs: number;
  tokensUsed: number;
  toolCallsTotal: number;
  toolSuccessCount: number;
  toolErrorCount: number;
  todoToolCalls: number;
  filesReadCount: number;
  filesModifiedCount: number;
  filesCreatedCount: number;
  driftDomainCount: number;
  driftDomains: string[];
  executionPhase: string;
  phaseDurationsMs: Record<string, number>;
  phaseTransitionCount: number;
  phaseTransitions: unknown[];
  ledger: { failedSteps: number; pendingSteps: number };
  qualityGate: { status: string; score: number; reasons: string[] } | null;
  /** Fraction of iterations that repeated intent without new evidence. */
  repeatNoEvidenceRate?: number;
}

export interface ToolOutcomeInput {
  toolName: string;
  success: boolean;
  durationMs: number;
  errorCode?: string;
  retryable?: boolean;
}

export interface KpiBaselinePersister {
  getKpiBaseline(sessionId: string): Promise<KpiBaseline | null>;
  updateKpiBaseline(
    sessionId: string,
    fn: () => {
      version: number;
      updatedAt: string;
      driftRateEma: number;
      evidenceDensityEma: number;
      toolErrorRateEma: number;
      samples: number;
      tokenHistory: number[];
      iterationUtilizationHistory: number[];
      qualityScoreHistory: number[];
    },
  ): Promise<void>;
}

export interface EmitContext {
  analytics: { track(event: string, payload: unknown): Promise<void> } | null;
  sessionId?: string;
  persister?: KpiBaselinePersister;
  baselineKey: string;
  log: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Process-level KPI baseline (module scope — one per process, like the old static)
// ---------------------------------------------------------------------------

const PROCESS_KPI_BASELINES = new Map<string, KpiBaseline>();

/** For testing: clear the process-level baseline map */
export function clearProcessKpiBaselines(): void {
  PROCESS_KPI_BASELINES.clear();
}

// ---------------------------------------------------------------------------
// RunMetricsEmitter
// ---------------------------------------------------------------------------

export class RunMetricsEmitter {
  readonly tierEscalations: TierEscalation[] = [];

  // ── Tier escalation ────────────────────────────────────────────────────

  async recordTierEscalation(
    from: string,
    to: string,
    reason: string,
    iteration: number,
    ctx: {
      analytics: EmitContext['analytics'];
      sessionId?: string;
      agentId: string;
      task: string;
      tierEscalatedEvent: string;
      log: (msg: string) => void;
    },
  ): Promise<void> {
    this.tierEscalations.push({ from, to, reason, iteration });

    if (!ctx.analytics) {
      return;
    }

    await ctx.analytics
      .track(ctx.tierEscalatedEvent, {
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        task: ctx.task,
        fromTier: from,
        toTier: to,
        reason,
        iteration,
        escalationCount: this.tierEscalations.length,
      })
      .catch((err) => {
        ctx.log(`[Agent] Failed to emit tier escalation analytics: ${err}`);
      });
  }

  // ── Tool outcome ───────────────────────────────────────────────────────

  trackToolOutcome(
    input: ToolOutcomeInput,
    ctx: {
      analytics: EmitContext['analytics'];
      toolCalledEvent: string;
      log: (msg: string) => void;
    },
  ): void {
    if (!ctx.analytics) {
      return;
    }

    void ctx.analytics
      .track(ctx.toolCalledEvent, {
        toolName: input.toolName,
        success: input.success,
        durationMs: input.durationMs,
        errorCode: input.errorCode,
        retryable: input.retryable,
      })
      .catch((err) => {
        ctx.log(`[Agent] Failed to emit tool analytics: ${String(err)}`);
      });
  }

  // ── Run KPIs ───────────────────────────────────────────────────────────

  async emitRunKpis(payload: RunKpiPayload, ctx: EmitContext): Promise<void> {
    if (!ctx.analytics) {
      return;
    }
    const qualityGateStatus = payload.qualityGate?.status ?? (payload.success ? 'pass' : 'partial');
    const qualityScore = payload.qualityGate?.score ?? (payload.success ? 1 : 0);
    const qualityReasons = payload.qualityGate?.reasons ?? [];

    const toolCallsTotal = payload.toolCallsTotal;
    const driftRate =
      toolCallsTotal > 0
        ? Math.max(0, payload.driftDomainCount - 1) / toolCallsTotal
        : 0;
    const evidenceCount =
      payload.filesReadCount + payload.filesModifiedCount + payload.filesCreatedCount;
    const evidenceDensity =
      payload.iterationsUsed > 0
        ? evidenceCount / payload.iterationsUsed
        : evidenceCount;
    const toolErrorRate =
      toolCallsTotal > 0 ? payload.toolErrorCount / toolCallsTotal : 0;
    const iterationUtilization =
      payload.iterationBudget > 0
        ? payload.iterationsUsed / payload.iterationBudget
        : 1;

    const fullPayload = {
      ...payload,
      qualityGate: {
        status: qualityGateStatus,
        score: qualityScore,
        reasons: qualityReasons,
      },
      escalated: this.tierEscalations.length > 0,
      escalationCount: this.tierEscalations.length,
      escalationReasons: this.tierEscalations.map((e) => e.reason),
      escalationPath: this.tierEscalations.map((e) => `${e.from}->${e.to}`),
      toolErrorRate,
      todoUsed: payload.todoToolCalls > 0,
      evidenceDensity,
      driftRate,
      iterationUtilization,
    };

    const regressionMetrics: RegressionMetrics = {
      driftRate,
      evidenceDensity,
      toolErrorRate,
      tokensUsed: payload.tokensUsed,
      iterationsUsed: payload.iterationsUsed,
      iterationBudget: payload.iterationBudget,
      iterationUtilization,
      qualityScore,
      qualityGateStatus,
    };

    await this.emitQualityRegressionEvent(regressionMetrics, ctx);

    await ctx.analytics.track('agent.kpi.run_completed', fullPayload).catch((err) => {
      ctx.log(`[Agent] Failed to emit KPI analytics: ${err}`);
    });
  }

  // ── Quality regression detection ───────────────────────────────────────

  private async emitQualityRegressionEvent(
    metrics: RegressionMetrics,
    ctx: EmitContext,
  ): Promise<void> {
    if (!ctx.analytics) {
      return;
    }

    let baseline: KpiBaseline = {
      driftRateEma: metrics.driftRate,
      evidenceDensityEma: metrics.evidenceDensity,
      toolErrorRateEma: metrics.toolErrorRate,
      samples: 0,
      tokenHistory: [],
      iterationUtilizationHistory: [],
      qualityScoreHistory: [],
    };

    if (ctx.sessionId && ctx.persister) {
      try {
        const persisted = await ctx.persister.getKpiBaseline(ctx.sessionId);
        if (persisted) {
          baseline = persisted;
        }
      } catch (err) {
        ctx.log(`[Agent] Failed to read persisted KPI baseline: ${err}`);
      }
    } else {
      baseline = PROCESS_KPI_BASELINES.get(ctx.baselineKey) ?? baseline;
    }

    const verdict = detectQualityRegression(metrics, baseline);

    if (verdict.regressed) {
      await ctx.analytics
        .track('agent.kpi.quality_regression', {
          sessionId: ctx.sessionId,
          reasons: verdict.reasons,
          metrics,
          baseline: {
            driftRateEma: baseline.driftRateEma,
            evidenceDensityEma: baseline.evidenceDensityEma,
            toolErrorRateEma: baseline.toolErrorRateEma,
            samples: baseline.samples,
          },
        })
        .catch((err) => {
          ctx.log(`[Agent] Failed to emit quality regression analytics: ${err}`);
        });
    }

    const updated = updateKpiBaseline(baseline, metrics);

    if (ctx.persister && ctx.sessionId) {
      await ctx.persister
        .updateKpiBaseline(ctx.sessionId, () => ({
          version: 1,
          updatedAt: new Date().toISOString(),
          ...updated,
        }))
        .catch((err) => {
          ctx.log(`[Agent] Failed to persist KPI baseline: ${err}`);
        });
      return;
    }

    PROCESS_KPI_BASELINES.set(ctx.baselineKey, updated);
  }

  // ── Reset ──────────────────────────────────────────────────────────────

  reset(): void {
    this.tierEscalations.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Pure standalone functions
// ---------------------------------------------------------------------------

export function getKpiBaselineKey(
  sessionRootDir: string,
  workingDir: string,
): string {
  return `${sessionRootDir || workingDir || 'workspace'}::agent`;
}

export function detectQualityRegression(
  metrics: RegressionMetrics,
  baseline: KpiBaseline,
): { regressed: boolean; reasons: string[] } {
  const enoughHistory = baseline.samples >= 3;
  const driftRegressed =
    enoughHistory && metrics.driftRate > baseline.driftRateEma + 0.08;
  const evidenceRegressed =
    enoughHistory && metrics.evidenceDensity < baseline.evidenceDensityEma - 0.2;
  const errorRegressed =
    enoughHistory && metrics.toolErrorRate > baseline.toolErrorRateEma + 0.15;
  const overBudget =
    metrics.iterationBudget > 0
    && metrics.iterationsUsed / metrics.iterationBudget > 0.9;
  const partialGate = metrics.qualityGateStatus === 'partial';

  const regressed =
    driftRegressed || evidenceRegressed || errorRegressed || (partialGate && overBudget);

  const reasons: string[] = [];
  if (driftRegressed) { reasons.push('drift_rate_regressed'); }
  if (evidenceRegressed) { reasons.push('evidence_density_regressed'); }
  if (errorRegressed) { reasons.push('tool_error_rate_regressed'); }
  if (partialGate && overBudget) { reasons.push('partial_quality_near_budget_limit'); }

  return { regressed, reasons };
}

export function updateKpiBaseline(
  baseline: KpiBaseline,
  metrics: RegressionMetrics,
  alpha = 0.25,
): KpiBaseline {
  return {
    driftRateEma:
      baseline.samples === 0
        ? metrics.driftRate
        : baseline.driftRateEma * (1 - alpha) + metrics.driftRate * alpha,
    evidenceDensityEma:
      baseline.samples === 0
        ? metrics.evidenceDensity
        : baseline.evidenceDensityEma * (1 - alpha) + metrics.evidenceDensity * alpha,
    toolErrorRateEma:
      baseline.samples === 0
        ? metrics.toolErrorRate
        : baseline.toolErrorRateEma * (1 - alpha) + metrics.toolErrorRate * alpha,
    samples: baseline.samples + 1,
    tokenHistory: [...baseline.tokenHistory, metrics.tokensUsed].slice(-50),
    iterationUtilizationHistory: [
      ...baseline.iterationUtilizationHistory,
      metrics.iterationUtilization,
    ].slice(-50),
    qualityScoreHistory: [...baseline.qualityScoreHistory, metrics.qualityScore].slice(
      -50,
    ),
  };
}

export function extractToolErrorCode(result: {
  success: boolean;
  error?: string;
  errorDetails?: { code?: string; retryable?: boolean };
  metadata?: Record<string, unknown>;
}): string | null {
  if (result.errorDetails?.code) {
    return result.errorDetails.code;
  }
  if (
    result.metadata
    && typeof result.metadata.errorCode === 'string'
    && (result.metadata.errorCode as string).trim()
  ) {
    return result.metadata.errorCode as string;
  }
  const errorText = result.error || '';
  const prefixed = errorText.match(/^([A-Z0-9_]{3,}):/);
  return prefixed?.[1] || null;
}
