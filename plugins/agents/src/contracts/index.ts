/**
 * @kb-labs/agents/contracts
 *
 * Shared types, interfaces, and schemas for agents
 */

export type * from './types.js';
export type * from './events.js';
export type * from './ws-messages.js';
export type * from './verification.js';
export type * from './turn.js';
export * from './schemas.js';
export * from './routes.js';
export * from './analytics.js';
export * from './verification.js';

// ═══════════════════════════════════════════════════════════════════════
// Incremental Tracing (NEW)
// ═══════════════════════════════════════════════════════════════════════

export type * from './detailed-trace-types.js';
export type * from './trace-command-response.js';

// ═══════════════════════════════════════════════════════════════════════
// Control Flow (Agent v2)
// ═══════════════════════════════════════════════════════════════════════

export type * from './control.js';
export {
  StopPriority,
  DEFAULT_FEATURE_FLAGS,
} from './control.js';

// ═══════════════════════════════════════════════════════════════════════
// Configuration (File History)
// ═══════════════════════════════════════════════════════════════════════

export type * from './config-types.js';
export {
  DEFAULT_FILE_HISTORY_CONFIG,
  DEFAULT_AGENT_TOKEN_BUDGET_CONFIG,
} from './config-types.js';

// ═══════════════════════════════════════════════════════════════════════
// Tool Packs (Agent v2)
// ═══════════════════════════════════════════════════════════════════════

export type * from './tool-pack.js';
export type * from './runtime.js';
export type {
  ClaimVerificationResult,
  EvidenceRequirements,
  IterationSnapshot,
  MemoryRollup,
  PromptContextSelection,
  RepositoryModel,
  RepositoryTopology,
  RepositoryStack,
  RepositoryWorkspaceLayout,
  RepositoryConventions,
  RepositoryFingerprints,
  RunEvaluation,
  RunEvaluationRecommendation,
  RoutingHints,
  RepositorySignal,
  ToolCapability,
  TurnInterpretation,
  TurnKind,
} from './runtime.js';

// ═══════════════════════════════════════════════════════════════════════
// Sub-agent Spawning
// ═══════════════════════════════════════════════════════════════════════

export type * from './spawn.js';
