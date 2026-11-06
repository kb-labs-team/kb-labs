/**
 * Run Manager - tracks active agent runs for REST/WS API
 *
 * Uses platform cache for persistence and in-memory Map for active agents.
 * Cache stores serializable run state, Map stores live agent references.
 */

import type { IAgentRunner } from '../sdk/index.js';
import type { SessionManager } from '../core/index.js';
import type { Turn, TurnDelta } from '../contracts/index.js';
import { useCache } from '@kb-labs/sdk';

const CACHE_PREFIX = 'agent:run:';
const CACHE_TTL = 3600000; // 1 hour

/**
 * Run status
 */
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped';

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
 * Payload delivered to session-level listeners — the sole live-update
 * channel for a session's WS connection(s). `deltas` carries incremental
 * turn changes (see TurnDelta); `run:completed` is a terminal signal
 * carrying the finished run's outcome and, when available, the final
 * state of the assistant turn it produced.
 */
export type SessionBroadcastPayload =
  | { kind: 'deltas'; deltas: TurnDelta[] }
  | {
      kind: 'run:completed';
      runId: string;
      success: boolean;
      summary: string;
      durationMs: number;
      seq: number;
      turn?: Turn;
    };

type SessionListenerCallback = (payload: SessionBroadcastPayload) => void;

/**
 * Run Manager implementation
 */
class RunManagerImpl {
  /** Live agents (not cacheable) */
  private activeRuns: Map<string, ActiveRun> = new Map();

  /** Session-level listeners: sessionId → Set<callback> — receive updates from ALL runs in session */
  private sessionListeners: Map<string, Set<SessionListenerCallback>> = new Map();

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
    const cache = useCache();
    if (!cache) {return;}

    const state: RunState = {
      runId: run.runId,
      task: run.task,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      durationMs: run.durationMs,
      summary: run.summary,
      error: run.error,
    };

    await cache.set(`${CACHE_PREFIX}${run.runId}`, state, CACHE_TTL);
  }

  /**
   * Broadcast turn deltas to all session-level listeners. Callers MUST await
   * persistence (sessionManager.addEvent) before calling this, so listeners
   * never observe a delta whose underlying turn state isn't on disk yet —
   * that ordering is what makes gap-recovery / reconnect resume correct.
   */
  broadcastSessionDeltas(sessionId: string, deltas: TurnDelta[]): void {
    if (deltas.length === 0) { return; }
    this.notifySessionListeners(sessionId, { kind: 'deltas', deltas });
  }

  /**
   * Broadcast a run's terminal outcome to session-level listeners. Called
   * directly from the run's own completion handler (after `agent.execute()`
   * resolves) rather than derived reactively from an `agent:end` event —
   * the completion handler already has definitive success/summary/duration,
   * and this guarantees the message fires exactly once, deterministically.
   */
  broadcastRunCompleted(sessionId: string, payload: Omit<Extract<SessionBroadcastPayload, { kind: 'run:completed' }>, 'kind'>): void {
    this.notifySessionListeners(sessionId, { kind: 'run:completed', ...payload });
  }

  private notifySessionListeners(sessionId: string, payload: SessionBroadcastPayload): void {
    const listeners = this.sessionListeners.get(sessionId);
    if (!listeners) { return; }
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch {
        // Ignore listener errors — one bad WS connection shouldn't affect others
      }
    }
  }

  /**
   * Add a session-level listener — receives updates from ALL runs in this session.
   */
  addSessionListener(sessionId: string, callback: SessionListenerCallback): void {
    if (!this.sessionListeners.has(sessionId)) {
      this.sessionListeners.set(sessionId, new Set());
    }
    this.sessionListeners.get(sessionId)!.add(callback);
  }

  /**
   * Remove a session-level listener.
   */
  removeSessionListener(sessionId: string, callback: SessionListenerCallback): void {
    const listeners = this.sessionListeners.get(sessionId);
    if (listeners) {
      listeners.delete(callback);
      if (listeners.size === 0) {
        this.sessionListeners.delete(sessionId);
      }
    }
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
