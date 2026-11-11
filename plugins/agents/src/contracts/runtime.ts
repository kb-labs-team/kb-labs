/**
 * Runtime-centric contracts for the new SDK kernel/store architecture.
 *
 * These contracts intentionally model continuity state explicitly instead of
 * relying on transcript replay or middleware-local memory.
 */

import type { AgentMode } from './types.js';

export type RepositoryTopology =
  | 'single-package'
  | 'monorepo'
  | 'polyrepo'
  | 'workspace'
  | 'unknown';

export type ToolCapability =
  | 'filesystem'
  | 'search'
  | 'code-navigation'
  | 'shell'
  | 'memory'
  | 'planning'
  | 'todo'
  | 'interaction'
  | 'reporting'
  | 'delegation';

export interface RepositoryStack {
  languages: string[];
  frameworks: string[];
  runtimes: string[];
  packageManagers: string[];
  buildTools: string[];
  testTools: string[];
}

export interface RepositorySignal {
  name: string;
  confidence: number;
  sources: string[];
}

export interface RepositoryFingerprints {
  ecosystems: RepositorySignal[];
  languages: RepositorySignal[];
  frameworks: RepositorySignal[];
  runtimes: RepositorySignal[];
  packageManagers: RepositorySignal[];
  buildTools: RepositorySignal[];
  testTools: RepositorySignal[];
}

export interface RepositoryWorkspaceLayout {
  rootPath: string;
  packageRoots: string[];
  appRoots: string[];
  libraryRoots: string[];
  infraRoots: string[];
  docsRoots: string[];
}

export interface RepositoryConventions {
  hasAdr: boolean;
  hasOpenApi: boolean;
  hasCi: boolean;
  hasLinting: boolean;
  hasFormatting: boolean;
}

export interface RepositoryModel {
  topology: RepositoryTopology;
  stack: RepositoryStack;
  fingerprints: RepositoryFingerprints;
  workspace: RepositoryWorkspaceLayout;
  conventions: RepositoryConventions;
  riskSignals: string[];
  detectedAt: string;
  sources: string[];
}

export type TurnKind =
  | 'new_task'
  | 'follow_up'
  | 'correction'
  | 'constraint'
  | 'mixed';

export interface TurnInterpretation {
  kind: TurnKind;
  shouldPersist: boolean;
  persistenceKind?: 'correction' | 'constraint';
  persistStrategy?: 'record_directly' | 'explicit_commit';
  content?: string;
  invalidates?: string[];
  confidence: number;
  suggestedMode?: AgentMode | 'assistant' | 'autonomous' | 'spec' | 'debug';
  suggestedSkills?: string[];
  suggestedPromptProfile?: string;
  suggestedToolCapabilities?: string[];
  rationale?: string;
}

export interface RoutingHints {
  suggestedMode?: AgentMode | 'assistant' | 'autonomous' | 'spec' | 'debug';
  suggestedSkills: string[];
  suggestedPromptProfile?: string;
  suggestedToolCapabilities: string[];
  source: 'turn_interpretation';
  confidence: number;
  updatedAt: string;
}

export interface MemoryRollup {
  generatedAt: string;
  turnCount?: number;
  toolCallCount?: number;
  completedActionCount: number;
  prunedEvidenceCount: number;
  summary: string;
}

export interface EvidenceRequirements {
  allowsMemoryOnlyRecall: boolean;
  needsDirectToolEvidence: boolean;
  needsFileBackedClaims: boolean;
  allowsInference: boolean;
  maxUnsupportedClaims: number;
}

export interface ClaimVerificationResult {
  verdict: 'allow' | 'warn' | 'block';
  rationale: string;
  requirements: EvidenceRequirements;
  supportedClaims: string[];
  unsupportedClaims: string[];
}

export type RunEvaluationRecommendation = 'continue' | 'narrow' | 'synthesize';

export interface IterationSnapshot {
  iteration: number;
  maxIterations: number;
  toolNames: string[];
  toolSignature: string;
  totalTokens?: number;
  evidenceCount: number;
  evidenceDelta: number;
  filesReadCount: number;
  filesModifiedCount: number;
  filesCreatedCount: number;
  newEvidence: boolean;
  repeatsWithoutEvidence: number;
  repeatNoEvidenceCount: number;
  lastIterationSummary?: string;
}

export interface RunEvaluation {
  evidenceGain: number;
  readinessScore: number;
  repeatedStrategy: boolean;
  recommendation: RunEvaluationRecommendation;
  rationale: string;
}

export interface PromptContextSelection {
  includeObjective: boolean;
  includeSessionRollup: boolean;
  includeConstraints: boolean;
  includeRoutingHints: boolean;
  includeCorrections: boolean;
  includeDecisions: boolean;
  includeEvidence: boolean;
  includePreviousRunToolUsage: boolean;
  includePreviousRunHandoff: boolean;
  includeWorkingSummary: boolean;
  includePendingActions: boolean;
  correctionWindow: number;
  decisionWindow: number;
  evidenceWindow: number;
  toolUsageWindow: number;
  pendingActionWindow: number;
  rationale?: string;
}

export type KernelEntryKind =
  | 'objective'
  | 'constraint'
  | 'correction'
  | 'assumption'
  | 'decision'
  | 'evidence'
  | 'question'
  | 'todo'
  | 'handoff'
  | 'child-result'
  | 'summary';

export interface CorrectionRecord {
  id: string;
  content: string;
  timestamp: string;
  invalidates?: string[];
  source: 'user' | 'system';
}

export interface AssumptionRecord {
  id: string;
  content: string;
  status: 'active' | 'invalidated' | 'accepted';
  createdAt: string;
  invalidatedAt?: string;
  invalidatedBy?: string;
}

export interface DecisionRecord {
  id: string;
  content: string;
  createdAt: string;
  source: 'agent' | 'user' | 'tool';
  pinned?: boolean;
}

export interface EvidenceRecord {
  id: string;
  summary: string;
  source: string;
  createdAt: string;
  toolName?: string;
  toolInputSummary?: string;
  artifact?: Record<string, unknown>;
  filePaths?: string[];
  pinned?: boolean;
}

export interface OpenQuestionRecord {
  id: string;
  content: string;
  createdAt: string;
  status: 'open' | 'resolved';
}

export interface PendingActionRecord {
  id: string;
  content: string;
  createdAt: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
}

export interface RunHandoff {
  runId: string;
  mode: AgentMode | 'assistant' | 'autonomous';
  createdAt: string;
  summary: string;
  filesRead?: string[];
  filesModified?: string[];
  filesCreated?: string[];
  importantEvidenceIds?: string[];
}

export interface KernelMemoryState {
  corrections: CorrectionRecord[];
  assumptions: AssumptionRecord[];
  decisions: DecisionRecord[];
  evidence: EvidenceRecord[];
  openQuestions: OpenQuestionRecord[];
  pendingActions: PendingActionRecord[];
  latestSummary?: string;
}

export interface KernelState {
  version: number;
  sessionId: string;
  workingDir: string;
  mode: AgentMode | 'assistant' | 'autonomous';
  currentTask: string;
  objective?: string;
  constraints: string[];
  routingHints?: RoutingHints;
  rollup?: MemoryRollup;
  memory: KernelMemoryState;
  handoff?: RunHandoff;
  childResults: RunHandoff[];
  updatedAt: string;
}

export interface ToolResultArtifact {
  status: 'success' | 'error';
  summary: string;
  artifact?: Record<string, unknown>;
  evidence: EvidenceRecord[];
  mutations?: {
    filesRead?: string[];
    filesModified?: string[];
    filesCreated?: string[];
  };
  followUpHints?: string[];
}

export interface ToolCallRecord {
  id: string;
  sessionId: string;
  runId?: string;
  timestamp: string;
  toolName: string;
  input: Record<string, unknown>;
  artifact: ToolResultArtifact;
}

export interface SessionSnapshot {
  sessionId: string;
  mode: AgentMode | 'assistant' | 'autonomous';
  updatedAt: string;
  kernel: KernelState;
}

export interface RuntimeTurnRecord {
  id: string;
  sessionId: string;
  runId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}
