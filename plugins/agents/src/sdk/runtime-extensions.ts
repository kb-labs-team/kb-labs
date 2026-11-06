import type {
  AgentMode,
  CorrectionRecord,
  EvidenceRequirements,
  IterationSnapshot,
  KernelState,
  PromptContextSelection,
  RepositoryConventions,
  RepositoryFingerprints,
  RepositoryModel,
  RepositoryStack,
  RepositoryTopology,
  RepositoryWorkspaceLayout,
  RunEvaluation,
  TaskResult,
  ToolCallRecord,
  ToolCapability,
  TurnInterpretation,
} from '../contracts/index.js';
import type { RunContext } from './contexts.js';
import type { LLMMessage } from '@kb-labs/sdk';

export interface ResponseRequirements {
  requirements: EvidenceRequirements;
  rationale: string;
}

export interface ToolPolicy {
  access: 'restricted' | 'read-only' | 'controlled' | 'balanced' | 'aggressive';
  allowedToolNames?: string[];
  allowedCapabilities?: ToolCapability[];
  blockedCapabilities?: ToolCapability[];
}

export interface DirectAnswerResolution {
  answer: string;
  confidence: number;
  filesRead?: string[];
}

export interface ModePolicy {
  id: string;
  mode: AgentMode | 'assistant' | 'autonomous';
  describe(): {
    responseStyle: 'dialogue-first' | 'execution-first' | 'planning-first';
    toolUse: 'controlled' | 'balanced' | 'aggressive';
  };
}

export interface RepositoryDiagnosticsProvider {
  id: string;
  describe(input: {
    workingDir: string;
    mode: AgentMode | 'assistant' | 'autonomous';
    profile: RuntimeProfile | null;
    kernel: KernelState | null;
  }): Promise<RepositoryModel | null> | RepositoryModel | null;
}

export interface RepositoryProbeObservation {
  topology?: RepositoryTopology;
  stack?: Partial<RepositoryStack>;
  fingerprints?: Partial<RepositoryFingerprints>;
  workspace?: Partial<RepositoryWorkspaceLayout>;
  conventions?: Partial<RepositoryConventions>;
  riskSignals?: string[];
  sources?: string[];
}

export interface RepositoryProbe {
  id: string;
  probe(input: {
    workingDir: string;
    mode: AgentMode | 'assistant' | 'autonomous';
    profile: RuntimeProfile | null;
    kernel: KernelState | null;
    fileNames: string[];
  }): Promise<RepositoryProbeObservation | null> | RepositoryProbeObservation | null;
}

export interface ToolCapabilityResolver {
  id: string;
  resolve(input: {
    workingDir: string;
    mode: AgentMode | 'assistant' | 'autonomous';
    profile: RuntimeProfile | null;
    repositoryModel: RepositoryModel | null;
    kernel: KernelState | null;
  }): Promise<ToolCapability[] | null> | ToolCapability[] | null;
}

export interface MemoryCapability {
  id: string;
  apply(state: KernelState): KernelState | Promise<KernelState>;
}

export interface PromptProjector {
  id: string;
  project(input: {
    state: KernelState;
    messages: LLMMessage[];
    repositoryModel?: RepositoryModel | null;
    toolCapabilities?: ToolCapability[];
  }): string | Promise<string>;
}

export interface PromptContextSelector {
  id: string;
  select(input: {
    state: KernelState;
    messages: LLMMessage[];
    responseRequirements?: ResponseRequirements;
  }): PromptContextSelection | Promise<PromptContextSelection>;
}

export interface ResponseRequirementsSelector {
  id: string;
  select(input: {
    state: KernelState | null;
    messages: LLMMessage[];
    task: string;
  }): ResponseRequirements | Promise<ResponseRequirements>;
}

export interface SessionRecallResolver {
  id: string;
  resolve(input: {
    state: KernelState;
    messages: LLMMessage[];
    task: string;
    toolRecords: ToolCallRecord[];
    responseRequirements?: ResponseRequirements;
  }): Promise<DirectAnswerResolution | null> | DirectAnswerResolution | null;
}

export interface OutputValidationResult {
  verdict: 'allow' | 'warn' | 'block';
  rationale: string;
}

export interface OutputValidator {
  id: string;
  validate(input: {
    state: KernelState;
    answer: string;
    mode: AgentMode | 'assistant' | 'autonomous';
    metadata?: Record<string, unknown>;
  }): Promise<OutputValidationResult | null> | OutputValidationResult | null;
}

export interface ArtifactWriter {
  id: string;
  write(input: {
    state: KernelState;
    sessionId: string;
    summary: string;
    runId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> | void;
}

export interface ResultMapperResult {
  taskResult?: Partial<TaskResult>;
  runtimeMetadata?: Record<string, unknown>;
  summary?: string;
}

export interface ResultMapper {
  id: string;
  map(input: {
    state: KernelState | null;
    answer: string;
    mode: AgentMode | 'assistant' | 'autonomous';
    task: string;
    sessionId?: string;
    workingDir: string;
    metadata?: Record<string, unknown>;
  }): Promise<ResultMapperResult | null> | ResultMapperResult | null;
}

export interface CompletionPolicy {
  requireReportTool?: boolean;
  requireValidatorsToPass?: boolean;
}

export interface RuntimeProfile {
  id: string;
  mode: AgentMode | 'assistant' | 'autonomous';
  description?: string;
  toolPolicy?: ToolPolicy;
  repositoryDiagnosticsProviders?: RepositoryDiagnosticsProvider[];
  repositoryProbes?: RepositoryProbe[];
  toolCapabilityResolvers?: ToolCapabilityResolver[];
  promptContextSelectors?: PromptContextSelector[];
  responseRequirementsSelectors?: ResponseRequirementsSelector[];
  promptProjectors?: PromptProjector[];
  sessionRecallResolvers?: SessionRecallResolver[];
  runEvaluators?: RunEvaluator[];
  resultMappers?: ResultMapper[];
  outputValidators?: OutputValidator[];
  artifactWriters?: ArtifactWriter[];
  completionPolicy?: CompletionPolicy;
}

export interface RuntimeObserver {
  id: string;
  onKernelUpdated?(state: KernelState): void | Promise<void>;
  onToolCall?(record: ToolCallRecord): void | Promise<void>;
  onCorrection?(record: CorrectionRecord): void | Promise<void>;
}

export interface TurnInterpreter {
  id: string;
  supports(mode: AgentMode | 'assistant' | 'autonomous'): boolean;
  interpret(input: {
    sessionId?: string;
    mode: AgentMode | 'assistant' | 'autonomous';
    message: string;
    kernel: KernelState | null;
  }): Promise<TurnInterpretation | null> | TurnInterpretation | null;
}

export interface RunEvaluator {
  id: string;
  evaluate(input: {
    run: RunContext;
    snapshot: IterationSnapshot;
  }): Promise<RunEvaluation | null> | RunEvaluation | null;
}
