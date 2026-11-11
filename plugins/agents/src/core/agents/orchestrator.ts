/**
 * SubAgentOrchestrator — delegation strategy and spawn lifecycle.
 *
 * Strategies:
 * - 'auto'       — LLM decides whether/how to decompose (future: use LLM call)
 * - 'sequential' — spawn sub-agents one at a time in order
 * - 'parallel'   — spawn all sub-agents concurrently (via ParallelExecutor)
 *
 * The orchestrator composes AgentRegistry + ParallelExecutor and provides
 * the spawn function used by TaskMiddleware for async sub-agent delegation.
 */

import type { AgentRegistry} from './agent-registry.js';
import { globalAgentRegistry } from './agent-registry.js';
import { ParallelExecutor } from './parallel-executor.js';
import type {
  SubAgentRequest,
  SubAgentResult,
  AgentRunner,
  ParallelExecutorConfig,
} from './parallel-executor.js';

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

export type DelegationStrategy = 'auto' | 'sequential' | 'parallel';

export interface OrchestratorConfig {
  /** Strategy for delegating subtasks. Default: 'sequential' */
  strategy: DelegationStrategy;
  /** ParallelExecutor config (used for 'parallel' and 'auto' strategies) */
  executor: Partial<ParallelExecutorConfig>;
  /** Agent registry (default: globalAgentRegistry) */
  registry?: AgentRegistry;
  /** Current depth (incremented for each level of nesting) */
  depth: number;
}

/**
 * A single spawn request from the tool layer.
 * Used by TaskMiddleware's spawnFn to create sub-agents.
 */
export interface LegacySpawnRequest {
  task: string;
  maxIterations?: number;
  workingDir?: string;
}

/**
 * Result returned to the tool layer.
 */
export interface LegacySpawnResult {
  success: boolean;
  result: string;
  iterations: number;
  tokensUsed: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  strategy: 'sequential',
  executor: {},
  depth: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SubAgentOrchestrator
// ═══════════════════════════════════════════════════════════════════════

export class SubAgentOrchestrator {
  private readonly config: OrchestratorConfig;
  private readonly registry: AgentRegistry;
  private readonly executor: ParallelExecutor;

  constructor(
    runner: AgentRunner,
    parentSignal: AbortSignal,
    config: Partial<OrchestratorConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = config.registry ?? globalAgentRegistry;
    this.executor = new ParallelExecutor(runner, parentSignal, this.config.executor);
  }

  /**
   * Spawn a single sub-agent.
   */
  async spawnOne(req: LegacySpawnRequest): Promise<LegacySpawnResult> {
    const subReq: SubAgentRequest = {
      task: req.task,
      agentType: 'researcher', // default type
      maxIterations: req.maxIterations,
      workingDir: req.workingDir,
    };

    const result = await this.executor.submit(subReq, 0, this.config.depth);
    return this.toLegacyResult(result);
  }

  /**
   * Spawn multiple sub-agents using the configured strategy.
   */
  async spawnMany(
    requests: SubAgentRequest[],
    strategy?: DelegationStrategy,
  ): Promise<SubAgentResult[]> {
    const strat = strategy ?? this.config.strategy;

    if (strat === 'parallel') {
      return this.executor.executeAll(requests, this.config.depth);
    }

    // sequential / auto fallback
    const results: SubAgentResult[] = [];
    for (const req of requests) {
      const result = await this.executor.submit(req, 0, this.config.depth);
      results.push(result);
      // Early exit if parent was aborted
      if (result.error?.includes('aborted')) {break;}
    }
    return results;
  }

  /**
   * Resolve an agent type definition from the registry.
   * Returns undefined if agentType is not registered.
   */
  resolveAgentType(agentType: string) {
    return this.registry.get(agentType);
  }

  /**
   * Return executor stats for monitoring.
   */
  stats() {
    return this.executor.stats();
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private toLegacyResult(r: SubAgentResult): LegacySpawnResult {
    return {
      success: r.success,
      result: r.error ? `Error: ${r.error}` : r.result,
      iterations: r.iterations,
      tokensUsed: r.tokensUsed,
    };
  }
}
