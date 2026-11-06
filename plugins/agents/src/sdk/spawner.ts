/**
 * IAgentSpawner — contract for spawning sub-agents.
 *
 * The spawner is registered in RunContext.meta by AgentRunner at startup:
 *   ctx.meta.get<IAgentSpawner>('core', 'spawner')
 *
 * This makes it accessible to any middleware or tool without direct coupling
 * to AgentRunner.
 *
 * Implementation lives in agent-core (AgentSpawner).
 * Enforcement:
 *   - canSpawn() checks depth, allowed profiles, and remaining budget
 *   - budgetPartition is deducted from parent's remaining token budget
 *   - parent's AbortSignal is wired to all child AbortControllers
 */

import type { TaskResult } from '../contracts/index.js';
import type { ToolPack } from '../contracts/index.js';
import type { RunContext } from './contexts.js';

// ─────────────────────────────────────────────────────────────────────────────
// SpawnOptions
// ─────────────────────────────────────────────────────────────────────────────

export interface SpawnOptions {
  /** Profile ID to use — must be registered in the parent SDK */
  profileId: string;

  /** Task string for the sub-agent */
  task: string;

  /** Parent context — used to inherit requestId, abortSignal, deadlineMs */
  parentContext: RunContext;

  /**
   * Fraction of parent's remaining token budget to allocate (0.0–1.0).
   * Default: 0.3 (30%).
   */
  budgetPartition?: number;

  /** Additional tool packs available only to this sub-agent */
  additionalPacks?: ToolPack[];
}

// ─────────────────────────────────────────────────────────────────────────────
// SpawnResult
// ─────────────────────────────────────────────────────────────────────────────

export interface SpawnResult {
  result: TaskResult;
  /** Actual tokens consumed — parent should deduct this from its budget */
  tokensConsumed: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// IAgentSpawner interface
// ─────────────────────────────────────────────────────────────────────────────

export interface IAgentSpawner {
  /** Spawn a single sub-agent and await its result */
  spawn(options: SpawnOptions): Promise<SpawnResult>;

  /**
   * Spawn multiple sub-agents in parallel.
   * The budgetPartition is divided equally among all spawned agents.
   */
  spawnParallel(options: SpawnOptions[]): Promise<SpawnResult[]>;

  /**
   * Check whether spawning is allowed in the current context.
   * Returns false if depth limit is reached, profile is not allowed,
   * or remaining budget is insufficient.
   */
  canSpawn(profileId: string, ctx: RunContext): boolean;
}
