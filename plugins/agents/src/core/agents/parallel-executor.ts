/**
 * ParallelExecutor — resource-governed parallel sub-agent execution.
 *
 * Features:
 * - Concurrency cap: at most `maxConcurrent` agents run simultaneously
 * - Cancel tree: parent AbortController propagates to all children
 * - Budget partition: parent token budget split across children (equal | weighted)
 * - Dedupe key: identical tasks share one execution
 * - Backpressure: queue size cap, reject or wait when queue is full
 * - Join timeout: collect results up to `joinTimeoutMs`, return partial on timeout
 * - MaxDepth: prevents runaway recursion
 *
 * The executor is generic: it calls a `runner` function you provide,
 * so it has no direct dependency on the Agent class (testable in isolation).
 */

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

export interface SubAgentRequest {
  /** Unique task description */
  task: string;
  /** Agent type from registry (default: 'researcher') */
  agentType?: string;
  /** Override max iterations for this specific spawn */
  maxIterations?: number;
  /** Working directory (relative to project root) */
  workingDir?: string;
  /**
   * Dedup key — if another pending/running task has the same key,
   * this request joins that result instead of spawning a new agent.
   * Default: task string itself.
   */
  dedupeKey?: string;
  /** Weight for budget partition (1 = equal share). Default: 1 */
  weight?: number;
}

export interface SubAgentResult {
  task: string;
  agentType: string;
  success: boolean;
  result: string;
  iterations: number;
  tokensUsed: number;
  /** True if this result came from a deduped execution */
  deduped?: boolean;
  /** Error message if success=false */
  error?: string;
  /** Whether the result was collected before timeout */
  timedOut?: boolean;
}

export type TokenPartitionStrategy = 'equal' | 'weighted';

export interface ParallelExecutorConfig {
  /** Maximum simultaneously running agents. Default: 5 */
  maxConcurrent: number;
  /** Maximum queue size (pending, not running). Reject beyond this. Default: 20 */
  maxQueueSize: number;
  /** Maximum nesting depth. 0 = cannot spawn. Default: 3 */
  maxDepth: number;
  /** Maximum time to wait for all agents to complete (ms). Default: 120_000 */
  joinTimeoutMs: number;
  /** How to split token budget across children. Default: 'equal' */
  tokenPartition: TokenPartitionStrategy;
  /** Total token budget available to share (0 = unlimited). Default: 0 */
  parentTokenBudget: number;
}

const DEFAULT_CONFIG: ParallelExecutorConfig = {
  maxConcurrent: 5,
  maxQueueSize: 20,
  maxDepth: 3,
  joinTimeoutMs: 120_000,
  tokenPartition: 'equal',
  parentTokenBudget: 0,
};

/**
 * Function signature for actually running a sub-agent.
 * Injected by the caller (Agent or test stub).
 */
export type AgentRunner = (
  request: SubAgentRequest,
  tokenBudget: number,
  signal: AbortSignal,
) => Promise<SubAgentResult>;

// ═══════════════════════════════════════════════════════════════════════
// ParallelExecutor
// ═══════════════════════════════════════════════════════════════════════

export class ParallelExecutor {
  private readonly config: ParallelExecutorConfig;
  private readonly runner: AgentRunner;
  private readonly parentSignal: AbortSignal;

  /** Currently running slot count */
  private running = 0;
  /** Pending tasks waiting for a slot */
  private readonly queue: Array<() => void> = [];
  /** Dedup map: key → shared promise */
  private readonly dedupeMap = new Map<string, Promise<SubAgentResult>>();

  constructor(
    runner: AgentRunner,
    parentSignal: AbortSignal,
    config: Partial<ParallelExecutorConfig> = {},
  ) {
    this.runner = runner;
    this.parentSignal = parentSignal;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Submit a batch of requests and collect results.
   * Returns when all finish or joinTimeoutMs elapses (whichever comes first).
   * Timed-out tasks have `timedOut: true` in their result.
   */
  async executeAll(requests: SubAgentRequest[], depth = 0): Promise<SubAgentResult[]> {
    if (depth > this.config.maxDepth) {
      return requests.map((r) => ({
        task: r.task,
        agentType: r.agentType ?? 'researcher',
        success: false,
        result: '',
        iterations: 0,
        tokensUsed: 0,
        error: `MaxDepth (${this.config.maxDepth}) exceeded at depth ${depth}`,
      }));
    }

    if (this.parentSignal.aborted) {
      return requests.map((r) => ({
        task: r.task,
        agentType: r.agentType ?? 'researcher',
        success: false,
        result: '',
        iterations: 0,
        tokensUsed: 0,
        error: 'Parent agent aborted',
      }));
    }

    const tokenBudgets = this.partitionBudget(requests);

    const promises = requests.map((req, i) =>
      this.submit(req, tokenBudgets[i]!, depth),
    );

    return this.joinWithTimeout(promises, this.config.joinTimeoutMs);
  }

  /**
   * Submit a single request.
   * Handles dedup, backpressure, and concurrency limit.
   */
  async submit(req: SubAgentRequest, tokenBudget: number, depth = 0): Promise<SubAgentResult> {
    const key = req.dedupeKey ?? req.task;

    // Dedup: share existing execution
    const existing = this.dedupeMap.get(key);
    if (existing) {
      return existing.then((r) => ({ ...r, deduped: true }));
    }

    // Backpressure: reject if queue is full
    if (this.queue.length >= this.config.maxQueueSize) {
      return {
        task: req.task,
        agentType: req.agentType ?? 'researcher',
        success: false,
        result: '',
        iterations: 0,
        tokensUsed: 0,
        error: `Executor queue full (maxQueueSize: ${this.config.maxQueueSize})`,
      };
    }

    const promise = this.enqueue(req, tokenBudget, depth);
    this.dedupeMap.set(key, promise);

    // Clean up dedup entry when done
    promise.finally(() => {
      this.dedupeMap.delete(key);
    });

    return promise;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private enqueue(req: SubAgentRequest, tokenBudget: number, depth: number): Promise<SubAgentResult> {
    return new Promise((resolve) => {
      const attempt = () => {
        if (this.running < this.config.maxConcurrent) {
          this.running++;
          this.runOne(req, tokenBudget, depth)
            .then(resolve)
            .finally(() => {
              this.running--;
              this.drainQueue();
            });
        } else {
          // Park in queue
          this.queue.push(attempt);
        }
      };
      attempt();
    });
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.running < this.config.maxConcurrent) {
      const next = this.queue.shift()!;
      next();
    }
  }

  private async runOne(
    req: SubAgentRequest,
    tokenBudget: number,
    depth: number,
  ): Promise<SubAgentResult> {
    if (this.parentSignal.aborted) {
      return {
        task: req.task,
        agentType: req.agentType ?? 'researcher',
        success: false,
        result: '',
        iterations: 0,
        tokensUsed: 0,
        error: 'Parent agent aborted before execution',
      };
    }

    // Per-child AbortController linked to parent signal
    const childController = new AbortController();
    const onParentAbort = () => childController.abort();
    this.parentSignal.addEventListener('abort', onParentAbort, { once: true });

    try {
      return await this.runner(req, tokenBudget, childController.signal);
    } catch (error) {
      return {
        task: req.task,
        agentType: req.agentType ?? 'researcher',
        success: false,
        result: '',
        iterations: 0,
        tokensUsed: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.parentSignal.removeEventListener('abort', onParentAbort);
    }
  }

  private partitionBudget(requests: SubAgentRequest[]): number[] {
    const total = this.config.parentTokenBudget;
    if (total === 0 || requests.length === 0) {
      return requests.map(() => 0);
    }

    if (this.config.tokenPartition === 'equal') {
      const share = Math.floor(total / requests.length);
      return requests.map(() => share);
    }

    // Weighted partition
    const weights = requests.map((r) => r.weight ?? 1);
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    return weights.map((w) => Math.floor((w / totalWeight) * total));
  }

  private async joinWithTimeout(
    promises: Promise<SubAgentResult>[],
    timeoutMs: number,
  ): Promise<SubAgentResult[]> {
    if (promises.length === 0) {return [];}

    const timedOut = new Set<number>();
    const results: SubAgentResult[] = new Array(promises.length);

    // Wrap each promise with a timeout marker
    const raced = promises.map((p, i) => {
      const timer = new Promise<SubAgentResult>((resolve) => {
        setTimeout(() => {
          timedOut.add(i);
          resolve({
            task: '',
            agentType: '',
            success: false,
            result: '',
            iterations: 0,
            tokensUsed: 0,
            timedOut: true,
            error: `Timed out after ${timeoutMs}ms`,
          });
        }, timeoutMs);
      });
      return Promise.race([p, timer]).then((r) => {
        results[i] = r;
      });
    });

    await Promise.all(raced);
    return results;
  }

  /** Return current running/queue stats for monitoring. */
  stats(): { running: number; queued: number; deduped: number } {
    return {
      running: this.running,
      queued: this.queue.length,
      deduped: this.dedupeMap.size,
    };
  }
}
