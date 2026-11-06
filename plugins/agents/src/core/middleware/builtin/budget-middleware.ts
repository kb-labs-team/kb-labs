/**
 * BudgetMiddleware — token budget enforcement and convergence nudging.
 *
 * Hook points:
 * - beforeIteration: check hard limit → return 'stop' if exceeded
 * - beforeLLMCall: inject convergence nudge at soft limit via LLMCallPatch
 *
 * Token counter is injected via a simple getter — the runner owns totalTokens
 * and passes a closure. Everything else (policy, nudge state) lives here.
 */

import type { RunContext, LLMCtx, LLMCallPatch, ControlAction } from '../../../sdk/index.js';

export interface BudgetPolicy {
  active: boolean;
  maxTokens: number;
  softLimitRatio: number;
  hardLimitRatio: number;
  hardStop: boolean;
  forceSynthesisOnHardLimit: boolean;
}

/**
 * Diminishing returns detection thresholds.
 * If N consecutive iterations each consume fewer than DELTA_THRESHOLD tokens,
 * the agent is spinning without meaningful work — inject convergence nudge.
 */
const DIMINISHING_RETURNS_WINDOW = 3;
const DIMINISHING_DELTA_THRESHOLD = 500;

export class BudgetMiddleware {
  readonly name = 'budget';
  readonly order = 10;
  readonly config = { failPolicy: 'fail-closed' as const, timeoutMs: 2000 };

  private readonly policy: BudgetPolicy;
  private readonly getTokensUsed: () => number;
  private _convergenceNudgeSent = false;
  /** Token deltas per iteration for diminishing returns detection */
  private _iterationDeltas: number[] = [];
  private _lastIterTokens = 0;
  private _diminishingNudgeSent = false;

  constructor(policy: BudgetPolicy, getTokensUsed: () => number) {
    this.policy = policy;
    this.getTokensUsed = getTokensUsed;
  }

  get convergenceNudgeSent(): boolean {
    return this._convergenceNudgeSent;
  }

  beforeIteration(ctx: RunContext): ControlAction {
    if (!this.policy.active || this.policy.maxTokens <= 0) {return 'continue';}

    const used = this.getTokensUsed();
    const hardLimit = this.policy.maxTokens * this.policy.hardLimitRatio;

    // ── Diminishing returns tracking ──
    // Track how many tokens each iteration consumes.
    // If several consecutive iterations produce tiny deltas, agent is spinning.
    const delta = used - this._lastIterTokens;
    this._lastIterTokens = used;
    if (ctx.iteration > 1) {
      this._iterationDeltas.push(delta);
      if (this._iterationDeltas.length > DIMINISHING_RETURNS_WINDOW) {
        this._iterationDeltas.shift();
      }
    }

    // Expose budget state for Status Block
    ctx.meta.set('budget', 'tokensUsed', used);
    ctx.meta.set('budget', 'maxTokens', this.policy.maxTokens);

    if (used >= hardLimit) {
      ctx.meta.set('budget', 'exhausted', true);
      ctx.meta.set('budget', 'exhaustedReason', `Token hard limit: ${used}/${hardLimit}`);

      if (this.policy.hardStop || this.policy.forceSynthesisOnHardLimit) {
        ctx.meta.set('budget', 'forceSynthesis', this.policy.forceSynthesisOnHardLimit);
        ctx.eventBus.emit('middleware:event', {
          name: 'budget',
          event: 'hard_stop',
          data: { tokensUsed: used, maxTokens: hardLimit },
        });
        return 'stop';
      }
    }

    return 'continue';
  }

  beforeLLMCall(ctx: LLMCtx): LLMCallPatch | undefined {
    if (!this.policy.active || this.policy.maxTokens <= 0) {return undefined;}
    if (this._convergenceNudgeSent) {return undefined;}

    const used = this.getTokensUsed();
    const softLimit = this.policy.maxTokens * this.policy.softLimitRatio;

    if (used >= softLimit) {
      this._convergenceNudgeSent = true;
      ctx.run.meta.set('budget', 'convergenceNudgeSent', true);

      const utilPct = Math.round((used / this.policy.maxTokens) * 100);
      ctx.run.eventBus.emit('middleware:event', {
        name: 'budget',
        event: 'soft_warning',
        data: { tokensUsed: used, maxTokens: this.policy.maxTokens, ratio: utilPct },
      });
      return {
        messages: [
          ...ctx.messages,
          {
            role: 'user' as const,
            content:
              `⚠️ TOKEN BUDGET: ${utilPct}% consumed (${used.toLocaleString()}/${this.policy.maxTokens.toLocaleString()} tokens). ` +
              `You are approaching the limit. Call \`report\` NOW with whatever you have — a partial answer is better than hitting the hard limit with nothing. Do not start new research.`,
          },
        ],
      };
    }

    // ── Diminishing returns detection ──
    // If last N iterations each consumed < threshold tokens, agent is spinning.
    // Send one nudge (separate from soft limit nudge).
    if (
      !this._diminishingNudgeSent &&
      this._iterationDeltas.length >= DIMINISHING_RETURNS_WINDOW &&
      this._iterationDeltas.every(d => d < DIMINISHING_DELTA_THRESHOLD)
    ) {
      this._diminishingNudgeSent = true;
      ctx.run.eventBus.emit('middleware:event', {
        name: 'budget',
        event: 'diminishing_returns',
        data: {
          recentDeltas: [...this._iterationDeltas],
          threshold: DIMINISHING_DELTA_THRESHOLD,
          window: DIMINISHING_RETURNS_WINDOW,
        },
      });
      return {
        messages: [
          ...ctx.messages,
          {
            role: 'user' as const,
            content:
              `⚠️ DIMINISHING RETURNS: Your last ${DIMINISHING_RETURNS_WINDOW} iterations each consumed fewer than ${DIMINISHING_DELTA_THRESHOLD} tokens — you are not making meaningful progress. Either call \`report\` with what you have, try a completely different approach, or call \`ask_user\` for guidance.`,
          },
        ],
      };
    }

    return undefined;
  }

  reset(): void {
    this._convergenceNudgeSent = false;
    this._iterationDeltas = [];
    this._lastIterTokens = 0;
    this._diminishingNudgeSent = false;
  }
}
