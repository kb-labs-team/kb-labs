/**
 * TaskMiddleware — async task management for sub-agent operations.
 *
 * Manages a registry of async tasks submitted via task_submit tool.
 * Tasks run concurrently as sub-agents and can be polled (task_status)
 * or awaited (task_collect).
 *
 * Hook points:
 *   beforeLLMCall → inject pending/completed task summary into Status Block
 *   onStop        → cancel all pending tasks
 *
 * order = 25 (after FactSheet=20, before Progress=50)
 */

import type {
  LLMCtx,
  LLMCallPatch,
} from '@kb-labs/agent-sdk';
import type { AsyncTask } from '@kb-labs/agent-contracts';
import type { SpawnAgentRequest, SpawnAgentResult } from '@kb-labs/agent-contracts';
import type { AgentEventCallback } from '@kb-labs/agent-contracts';
import { randomUUID } from 'node:crypto';

export interface TaskMiddlewareConfig {
  /** Max concurrent async tasks (default: 3) */
  maxConcurrent?: number;
  onEvent?: AgentEventCallback;
  agentId?: string;
}

export type SpawnFn = (request: SpawnAgentRequest) => Promise<SpawnAgentResult>;

export class TaskMiddleware {
  readonly name = 'task-manager';
  readonly order = 25;
  readonly config = { failPolicy: 'fail-open' as const, timeoutMs: 1000 };

  private readonly tasks = new Map<string, AsyncTask>();
  private readonly promises = new Map<string, Promise<SpawnAgentResult>>();
  private readonly maxConcurrent: number;
  private spawnFn: SpawnFn | null = null;
  private readonly onEvent?: AgentEventCallback;
  private readonly agentId?: string;

  constructor(config: TaskMiddlewareConfig = {}) {
    this.maxConcurrent = config.maxConcurrent ?? 3;
    this.onEvent = config.onEvent;
    this.agentId = config.agentId;
  }

  /** Set the spawn function (called by runner during setup) */
  setSpawnFn(fn: SpawnFn): void {
    this.spawnFn = fn;
  }

  // ── Tool API ────────────────────────────────────────────────────────────────

  /**
   * Submit a new async task. Returns immediately with a task ID.
   */
  async submit(description: string, request: SpawnAgentRequest): Promise<AsyncTask> {
    if (!this.spawnFn) {
      throw new Error('TaskMiddleware: spawnFn not set — sub-agents not available');
    }

    const runningTasks = [...this.tasks.values()].filter(t => t.status === 'running');
    if (runningTasks.length >= this.maxConcurrent) {
      const ids = runningTasks.map(t => t.id).join('", "');
      throw new Error(
        `Max concurrent tasks (${this.maxConcurrent}) reached. ` +
        `Call task_collect("${runningTasks[0]!.id}") to wait for a result before submitting more. ` +
        `Running tasks: ["${ids}"]`
      );
    }

    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();

    const task: AsyncTask = {
      id,
      description,
      status: 'running',
      submittedAt: now,
      startedAt: now,
      preset: request.preset ?? 'research',
    };
    this.tasks.set(id, task);
    this.emitStart(id, description, request.harness);

    // Fire-and-forget: spawn sub-agent, update task on completion
    const promise = this.spawnFn({ ...request, subagentId: id }).then(
      (result) => {
        task.status = result.success ? 'completed' : 'failed';
        task.completedAt = new Date().toISOString();
        task.result = result.summary;
        if (!result.success && result.error) { task.error = result.error; }
        task.tokensUsed = result.tokensUsed;
        task.filesRead = result.filesRead;
        task.filesModified = result.filesModified;
        this.emitEnd(id, result.success ? 'completed' : 'failed', result.success ? result.summary : result.error ?? result.summary);
        return result;
      },
      (err) => {
        task.status = 'failed';
        task.completedAt = new Date().toISOString();
        task.error = err instanceof Error ? err.message : String(err);
        this.emitEnd(id, 'failed', task.error);
        throw err;
      },
    );
    this.promises.set(id, promise);

    return task;
  }

  private emitStart(subagentId: string, description: string, harness?: string): void {
    this.onEvent?.({ type: 'subagent:start', timestamp: new Date().toISOString(), agentId: this.agentId, data: { subagentId, description, harness } });
  }

  private emitEnd(subagentId: string, status: 'completed' | 'failed', summary: string): void {
    this.onEvent?.({ type: 'subagent:end', timestamp: new Date().toISOString(), agentId: this.agentId, data: { subagentId, status, summary } });
  }

  /**
   * Get status of one or all tasks.
   */
  getStatus(taskId?: string): AsyncTask | AsyncTask[] | null {
    if (taskId) {
      return this.tasks.get(taskId) ?? null;
    }
    return [...this.tasks.values()];
  }

  /**
   * Await a specific task and return its result.
   */
  async collect(taskId: string): Promise<SpawnAgentResult> {
    const promise = this.promises.get(taskId);
    if (!promise) {
      throw new Error(`TaskMiddleware: unknown task ID "${taskId}"`);
    }
    return promise;
  }

  // ── Middleware hooks ─────────────────────────────────────────────────────────

  /**
   * Inject task summary into context via meta (read by FactSheetMiddleware's Status Block).
   */
  beforeLLMCall(ctx: LLMCtx): LLMCallPatch | undefined {
    const tasks = [...this.tasks.values()];
    if (tasks.length === 0) { return undefined; }

    const running = tasks.filter(t => t.status === 'running');
    const completed = tasks.filter(t => t.status === 'completed');
    const failed = tasks.filter(t => t.status === 'failed');

    // Write summary to meta for Status Block consumption
    ctx.run.meta.set('tasks', 'running', running.length);
    ctx.run.meta.set('tasks', 'completed', completed.length);
    ctx.run.meta.set('tasks', 'failed', failed.length);
    ctx.run.meta.set('tasks', 'total', tasks.length);

    // Build a compact summary for newly completed tasks
    const newlyResolved = tasks.filter(t => t.status === 'completed' || t.status === 'failed').filter(t => {
      const key = `tasks:notified:${t.id}`;
      if (ctx.run.meta.get('tasks', key)) { return false; }
      ctx.run.meta.set('tasks', key, true);
      return true;
    });

    if (newlyResolved.length === 0) { return undefined; }

    // Inject both successes and failures so the orchestrator can react without
    // having to remember to poll/collect every task explicitly.
    const notifications = newlyResolved.map(t => {
      const status = t.status === 'completed' ? '✅' : '❌';
      const detail = (t.status === 'failed' ? t.error ?? t.result : t.result ?? t.error) ?? 'no details';
      return `${status} Task "${t.description}" (${t.id}) ${t.status}: ${detail}`;
    });

    const notifMsg = {
      role: 'user' as const,
      content: `[Async task update]\n${notifications.join('\n')}`,
    };

    return { messages: [...ctx.messages, notifMsg] };
  }

  /**
   * On stop: no cleanup needed — promises resolve/reject on their own.
   */
  onStop(): void {
    // Tasks will complete in the background. We don't cancel sub-agents
    // because they're already running and should finish gracefully.
  }
}
