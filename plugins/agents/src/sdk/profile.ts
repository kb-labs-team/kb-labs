/**
 * AgentProfile — defines the role and capabilities of an agent.
 *
 * Three roles:
 *   orchestrator — full rights, all modes (plan, spec), human-in-loop support
 *   sub-agent    — same rights as orchestrator but scoped context, limited iterations
 *   atomic       — minimal rights: one tool pack, no spawn, isolated execution
 *
 * Profiles are registered via sdk.withProfile() and applied at createRunner() time.
 */

import type { LLMTier } from '../contracts/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// AgentRole
// ─────────────────────────────────────────────────────────────────────────────

export type AgentRole = 'orchestrator' | 'sub-agent' | 'atomic';

// ─────────────────────────────────────────────────────────────────────────────
// AgentProfile interface
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentProfile {
  id: string;
  role: AgentRole;

  /** Base system prompt for this profile (appended to global system prompt) */
  systemPrompt?: string;

  /** Additional instruction bullets (appended after systemPrompt) */
  instructions?: string[];

  budget?: {
    maxIterations?: number;
    tier?: LLMTier;
    enableEscalation?: boolean;
    /** 0 = unlimited */
    tokenBudget?: number;
  };

  /**
   * Spawn configuration — only applicable for orchestrator and sub-agent roles.
   * Atomic agents cannot spawn sub-agents.
   */
  spawn?: {
    /** Maximum sub-agent depth (default: 3). Prevents infinite recursion. */
    maxDepth?: number;
    /** If set, only profiles in this list can be spawned by this agent */
    allowedProfiles?: string[];
  };
}
