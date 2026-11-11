/**
 * @kb-labs/agents/core
 *
 * Core agent implementation and orchestration
 */

// Planning
export * from './planning/index.js';

// Modes
export * from './modes/index.js';

// Execution primitives
export * from './execution/index.js';

// Prompt construction
export * from './prompt/index.js';

// Analytics and run metrics
export * from './analytics/index.js';

// Middleware pipeline
export * from './middleware/index.js';

// Tool management
export * from './tools/index.js';

// Sub-agent system
export * from './agents/index.js';

// SDK-native agent runner
export * from './core/index.js';

// New runtime foundation
export { SessionArtifactStore } from '../store/index.js';
export {
  createKernelState,
  ingestUserTurn,
  completePendingActions,
  isCorrectionPendingAction,
  recordCorrection,
  recordDecision,
  recordToolArtifact,
  projectKernelPrompt,
} from '../kernel/index.js';
export { createSessionMemoryBridge } from './core/session-memory-bridge.js';
