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
} from '../../../sdk/index.js';
import type { AsyncTask } from '../../../contracts/index.js';
import type { SpawnAgentRequest, SpawnAgentResult } from '../../../contracts/index.js';
import { randomUUID } from 'node:crypto';

export interface TaskMiddlewareConfig {
  /** Max concurrent async tasks (default: 3) */
  maxConcurrent?: number;
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

  constructor(config: TaskMiddlewareConfig = {}) {
    this.maxConcurrent = config.maxConcurrent ?? 3;
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

    // Fire-and-forget: spawn sub-agent, update task on completion
    const promise = this.spawnFn(request).then(
      (result) => {
        task.status = 'completed';
        task.completedAt = new Date().toISOString();
        task.result = result.summary;
        task.tokensUsed = result.tokensUsed;
        task.filesRead = result.filesRead;
        task.filesModified = result.filesModified;
        return result;
      },
      (err) => {
        task.status = 'failed';
        task.completedAt = new Date().toISOString();
        task.error = err instanceof Error ? err.message : String(err);
        throw err;
      },
    );
    this.promises.set(id, promise);

    return task;
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
    const newlyCompleted = completed.filter(t => {
      const key = `tasks:notified:${t.id}`;
      if (ctx.run.meta.get('tasks', key)) { return false; }
      ctx.run.meta.set('tasks', key, true);
      return true;
    });

    if (newlyCompleted.length === 0) { return undefined; }

    // Inject notification about completed tasks as user message
    const notifications = newlyCompleted.map(t => {
      const status = t.status === 'completed' ? '✅' : '❌';
      const detail = t.result ?? t.error ?? 'no details';
      return `${status} Task "${t.description}" (${t.id}): ${detail}`;
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
