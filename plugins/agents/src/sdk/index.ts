/**
 * @kb-labs/agents/sdk
 *
 * Composable agent builder. Contains:
 *   - All extension-point interfaces (AgentMiddleware, ToolGuard, OutputProcessor, etc.)
 *   - AgentSDK concrete class (the builder itself)
 *   - IAgentSDK interface (for mocking in tests)
 *
 * agent-core provides the runtime implementations (guards, processors, pipelines)
 * and registers a RunnerFactory via AgentSDK.setRunnerFactory().
 */

// Contexts and shared primitives
export type {
  ContextMeta,
  RunContext,
  LLMCtx,
  LLMCallPatch,
  LLMCallResult,
  ToolCallInput,
  ToolOutput,
  ToolExecCtx,
} from './contexts.js';

// Middleware
export type { ControlAction, AgentMiddleware } from './middleware.js';
export { BaseMiddleware } from './middleware.js';

// Tracer
export type {
  TraceLevel,
  TraceEvent,
  AgentTracer,
  RunStartEvent,
  RunEndEvent,
  IterStartEvent,
  IterEndEvent,
  LLMStartEvent,
  LLMEndEvent,
  ToolStartEvent,
  ToolEndEvent,
  EscalateEvent,
  AbortEvent,
  SpawnEvent,
} from './tracer.js';

// Mode
export type { ToolFilter, ToolFilterFn, AgentMode } from './mode.js';

// Memory
export type { MemoryEntry, AgentMemory } from './memory.js';

// Stop conditions
export type { StopConditionResult, StopCondition } from './stop-condition.js';

// Output processor
export type { OutputProcessor } from './output-processor.js';

// Guard
export type { ValidationResult, ToolGuard } from './guard.js';

// Input normalizer
export type { InputNormalizer } from './input-normalizer.js';

// Execution loop
export type { LoopContext, LoopOutput, LoopResult, ExecutionLoop } from './loop.js';

// Context strategy
export type { ContextStrategy } from './context-strategy.js';

// Budget
export type { BudgetSnapshot, BudgetDecision, IBudgetManager } from './budget.js';

// Profile
export type { AgentRole, AgentProfile } from './profile.js';

// Event bus
export type { AgentEvents, Unsubscribe, AgentEventBus } from './event-bus.js';

// Runtime extensions
export type {
  ArtifactWriter,
  CompletionPolicy,
  OutputValidationResult,
  OutputValidator,
  DirectAnswerResolution,
  ModePolicy,
  MemoryCapability,
  PromptContextSelector,
  PromptProjector,
  RepositoryDiagnosticsProvider,
  RepositoryProbe,
  RepositoryProbeObservation,
  ResultMapper,
  ResultMapperResult,
  ResponseRequirements,
  ResponseRequirementsSelector,
  RuntimeProfile,
  RunEvaluator,
  SessionRecallResolver,
  ToolCapabilityResolver,
  ToolPolicy,
  RuntimeObserver,
  TurnInterpreter,
} from './runtime-extensions.js';

// Spawner
export type { SpawnOptions, SpawnResult, IAgentSpawner } from './spawner.js';

// Error handler
export type { ToolErrorAction, LLMErrorAction, AgentErrorHandler } from './error-handler.js';

// SDK — builder class + interfaces
export type { IAgentRunner, IAgentSDK, RunnerFactory } from './sdk.js';
export { AgentSDK } from './sdk.js';
