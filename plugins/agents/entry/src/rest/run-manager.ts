/**
 * Run Manager - tracks active agent runs for REST/WS API
 *
 * Uses platform cache for persistence and in-memory Map for active agents.
 * Cache stores serializable run state, Map stores live agent references.
 */

import type { IAgentRunner } from '@kb-labs/agent-sdk';
import type { SessionManager } from '@kb-labs/agent-core';
import type { Turn } from '@kb-labs/agent-contracts';
import { useCache } from '@kb-labs/sdk';

const CACHE_PREFIX = 'agent:run:';
const CACHE_TTL = 3600000; // 1 hour

/**
 * Run status
 */
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';

/**
 * Serializable run state (stored in cache)
 */
export interface RunState {
  runId: string;
  task: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  summary?: string;
  error?: string;
}

/**
 * Active run with live agent (in-memory only)
 */
export interface ActiveRun extends RunState {
  agent?: IAgentRunner;
  sessionManager: SessionManager;
}

/**
 * Run Manager implementation
 */
class RunManagerImpl {
  /** Live agents (not cacheable) */
  private activeRuns: Map<string, ActiveRun> = new Map();

  /**
   * Generate unique run ID
   */
  generateRunId(): string {
    return `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  /**
   * Register a new run
   */
  async register(
    runId: string,
    task: string,
    agent: IAgentRunner | undefined,
    sessionManager: SessionManager,
  ): Promise<ActiveRun> {
    const now = new Date().toISOString();

    const run: ActiveRun = {
      runId,
      task,
      status: 'pending',
      agent,
      sessionManager,
      startedAt: now,
    };

    // Store in memory (for live agent)
    this.activeRuns.set(runId, run);

    // Store serializable state in cache
    await this.saveToCache(run);

    return run;
  }

  /**
   * Get run by ID (from memory first, then cache for state)
   */
  get(runId: string): ActiveRun | undefined {
    return this.activeRuns.get(runId);
  }

  /**
   * Check if run exists (in memory or cache)
   */
  async exists(runId: string): Promise<boolean> {
    // Check memory first
    if (this.activeRuns.has(runId)) {
      return true;
    }
    // Fallback to cache
    const state = await this.getState(runId);
    return state !== null;
  }

  /**
   * Get run state from cache (for completed runs or cross-process access)
   */
  async getState(runId: string): Promise<RunState | null> {
    const cache = useCache();
    if (!cache) {return null;}

    return cache.get<RunState>(`${CACHE_PREFIX}${runId}`);
  }

  /**
   * Resolve a run from this process or the shared cache. A cached pending/running
   * run without a live AgentRunner was interrupted by a process restart/crash.
   */
  async reconcileState(runId: string): Promise<RunState | null> {
    const liveRun = this.activeRuns.get(runId);
    if (liveRun) {
      return this.toRunState(liveRun);
    }

    const state = await this.getState(runId);
    if (!state || (state.status !== 'pending' && state.status !== 'running')) {
      return state;
    }

    const interrupted: RunState = {
      ...state,
      status: 'interrupted',
      completedAt: new Date().toISOString(),
      error: 'The agent process stopped before this run completed. Conversation history and memory are preserved; send a follow-up to continue.',
    };
    await this.writeRunState(interrupted);
    return interrupted;
  }

  /** Mark persisted streaming turns as terminal when their owning run is gone. */
  async reconcileSessionTurns(
    sessionManager: Pick<SessionManager, 'getTurns' | 'storeTurnSnapshot'>,
    sessionId: string,
    sourceTurns?: Turn[],
  ): Promise<Turn[]> {
    const turns = sourceTurns ?? await sessionManager.getTurns(sessionId);
    const reconciled: Turn[] = [];

    for (const turn of turns) {
      if (turn.type !== 'assistant' || turn.status !== 'streaming' || !turn.metadata.runId) {
        reconciled.push(turn);
        continue;
      }

      const state = await this.reconcileState(turn.metadata.runId);
      if (state?.status === 'pending' || state?.status === 'running') {
        reconciled.push(turn);
        continue;
      }

      const status: Turn['status'] = state?.status === 'completed'
        ? 'completed'
        : state?.status === 'failed' ? 'failed' : 'cancelled';
      const errorMessage = state?.error ?? (state?.status === 'stopped'
        ? 'Agent run was stopped before it returned a response.'
        : 'The agent process stopped before this run completed. Conversation history and memory are preserved; send a follow-up to continue.');
      const recovered: Turn = {
        ...turn,
        status,
        completedAt: state?.completedAt ?? new Date().toISOString(),
        ...(status === 'completed' ? {} : {
          error: {
            code: state?.status === 'failed' ? 'RUN_FAILED' : state?.status === 'stopped' ? 'RUN_STOPPED' : 'RUN_INTERRUPTED',
            message: errorMessage,
          },
        }),
      };

      await sessionManager.storeTurnSnapshot(sessionId, recovered);
      reconciled.push(recovered);
    }

    return reconciled;
  }

  /**
   * Update run status
   */
  async updateStatus(runId: string, status: RunStatus, extra?: Partial<RunState>): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (run) {
      run.status = status;
      if (extra) {
        Object.assign(run, extra);
      }
      await this.saveToCache(run);
    }
  }

  /**
   * Save run state to cache
   */
  private async saveToCache(run: ActiveRun): Promise<void> {
    await this.writeRunState(this.toRunState(run));
  }

  private toRunState(run: ActiveRun): RunState {
    return {
      runId: run.runId,
      task: run.task,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      durationMs: run.durationMs,
      summary: run.summary,
      error: run.error,
    };
  }

  private async writeRunState(state: RunState): Promise<void> {
    const cache = useCache();
    if (!cache) {return;}
    await cache.set(`${CACHE_PREFIX}${state.runId}`, state, CACHE_TTL);
  }

  /**
   * List all active runs
   */
  listActive(): Array<{ runId: string; task: string; status: RunStatus; startedAt: string }> {
    return Array.from(this.activeRuns.values()).map(r => ({
      runId: r.runId,
      task: r.task,
      status: r.status,
      startedAt: r.startedAt,
    }));
  }

  /**
   * Request graceful stop of a running agent (and its child agents via propagated AbortSignal).
   * Agent finishes its current tool call then exits at the next iteration boundary.
   */
  requestStop(runId: string): boolean {
    const run = this.activeRuns.get(runId);
    if (!run || run.status !== 'running' || !run.agent) {
      return false;
    }
    run.agent.requestStop();
    return true;
  }

  /**
   * Clean up completed runs from memory (cache handles its own TTL)
   */
  cleanup(): void {
    for (const [runId, run] of this.activeRuns) {
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'stopped') {
        // Remove from memory but keep in cache
        this.activeRuns.delete(runId);
      }
    }
  }
}

/**
 * Singleton instance — stored on globalThis so all bundled modules share one instance.
 * When tsup compiles multiple entry points, each gets its own module scope,
 * so a plain `export const RunManager = new RunManagerImpl()` creates separate instances.
 * Using globalThis ensures run-handler.js and session-stream-handler.js share one RunManager.
 */
const GLOBAL_KEY = '__kb_agent_run_manager__';
if (!(globalThis as Record<string, unknown>)[GLOBAL_KEY]) {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = new RunManagerImpl();
}
export const RunManager = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as RunManagerImpl;
