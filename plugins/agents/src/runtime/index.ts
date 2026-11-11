import type {
  AgentEvent,
  AgentMode,
  KernelState,
  PromptContextSelection,
  RepositoryFingerprints,
  RepositoryModel,
  RepositorySignal,
  RunHandoff,
  ToolCallRecord,
  ToolCapability,
  ToolResultArtifact,
  TurnInterpretation,
} from '../contracts/index.js';
import {
  applyMemoryCapabilities,
  compactKernelState,
  completePendingActions,
  createKernelState,
  ingestUserTurn,
  isCorrectionPendingAction,
  projectKernelPrompt,
  recordCorrection,
  recordRunHandoff,
  recordToolArtifact,
  summarizeAssistantTurn,
} from '../kernel/index.js';
import type { AgentSDK, RuntimeProfile } from '../sdk/index.js';
import { SessionArtifactStore } from '../store/index.js';
import type { LLMMessage } from '@kb-labs/sdk';
import { useLLM } from '@kb-labs/sdk/hooks';
import { createDefaultPromptContextSelector } from './default-prompt-context-selector.js';
import {
  createBuiltInRepositoryProbes,
  createDefaultRepositoryDiagnosticsProvider,
} from './default-repository-diagnostics.js';
import { createDefaultResponseRequirementsSelector } from './default-response-requirements-selector.js';
import { createDefaultSessionRecallResolver } from './default-session-recall-resolver.js';
import { createDefaultToolCapabilityResolver } from './default-tool-capability-resolver.js';
import { resolveRuntimeProfile, resolveRuntimeMode } from './profiles.js';
import type { RuntimeResponseRequirements } from './response-requirements.js';
import { createDefaultTurnInterpreter } from './default-turn-interpreter.js';

export { createDefaultResponseRequirementsSelector } from './default-response-requirements-selector.js';
export { resolveRuntimeMode, resolveRuntimeProfile } from './profiles.js';

export interface RunCompletionResult {
  persisted: boolean;
  validationResults: Array<{
    verdict: 'allow' | 'warn' | 'block';
    rationale: string;
  }>;
  artifactResults: unknown[];
  blockedByPolicy: boolean;
}

export class RuntimeEngine {
  private kernel: KernelState | null = null;
  private activeProfile: RuntimeProfile | null = null;
  private repositoryModel: RepositoryModel | null = null;
  private activeToolCapabilities: ToolCapability[] = [];
  private readonly pendingToolInputs = new Map<string, { toolName: string; input: Record<string, unknown> }>();
  private lastResponseRequirements: RuntimeResponseRequirements | null = null;

  constructor(
    private readonly sdk: AgentSDK,
    private readonly store: SessionArtifactStore,
  ) {}

  async loadOrCreateKernel(input: {
    sessionId: string;
    workingDir: string;
    mode?: AgentMode;
    task: string;
  }): Promise<KernelState> {
    const existing = await this.store.loadKernelState(input.sessionId);
    const runtimeMode = resolveRuntimeMode(input.mode);
    const state = existing ?? createKernelState({
      sessionId: input.sessionId,
      workingDir: input.workingDir,
      mode: runtimeMode,
      task: input.task,
    });
    this.activeProfile = resolveRuntimeProfile(this.sdk, runtimeMode);
    this.repositoryModel = await this.describeRepository({
      workingDir: input.workingDir,
      mode: runtimeMode,
      profile: this.activeProfile,
      kernel: state,
    });
    this.activeToolCapabilities = await this.resolveToolCapabilities({
      workingDir: input.workingDir,
      mode: runtimeMode,
      profile: this.activeProfile,
      repositoryModel: this.repositoryModel,
      kernel: state,
    });
    const interpretation = await this.interpretTurn({
      sessionId: input.sessionId,
      mode: runtimeMode,
      message: input.task,
      kernel: state,
    });
    const normalizedInterpretation = normalizeInterpretationPersistence(interpretation, Boolean(existing));
    this.kernel = ingestUserTurn(state, {
      content: input.task,
      interpretation: normalizedInterpretation,
    });
    this.kernel = await applyMemoryCapabilities(this.kernel, this.sdk.memoryCapabilities);
    await this.store.saveKernelState(input.sessionId, this.kernel);
    await this.store.appendTurn(input.sessionId, {
      id: `turn-user-${Date.now()}`,
      sessionId: input.sessionId,
      role: 'user',
      content: input.task,
      timestamp: new Date().toISOString(),
      metadata: normalizedInterpretation ? { interpretation: normalizedInterpretation } : undefined,
    });
    for (const observer of this.sdk.observers) {
      await observer.onKernelUpdated?.(this.kernel);
    }
    return this.kernel;
  }

  getKernel(): KernelState | null {
    return this.kernel;
  }

  getLastResponseRequirements(): RuntimeResponseRequirements | null {
    return this.lastResponseRequirements;
  }

  getActiveProfile(): RuntimeProfile | null {
    return this.activeProfile;
  }

  getRepositoryModel(): RepositoryModel | null {
    return this.repositoryModel;
  }

  getActiveToolCapabilities(): ToolCapability[] {
    return [...this.activeToolCapabilities];
  }

  async tryResolveDirectAnswer(messages: LLMMessage[]): Promise<{
    answer: string;
    confidence: number;
    filesRead: string[];
  } | null> {
    if (!this.kernel) {
      return null;
    }
    const task = getCurrentTaskForMessages(this.kernel, messages);
    const toolRecords = await this.store.loadToolRecords(this.kernel.sessionId, 300);
    const requirements = await this.selectResponseRequirements(this.kernel, messages);
    const resolvers = [
      ...(this.activeProfile?.sessionRecallResolvers ?? []),
      ...this.sdk.sessionRecallResolvers,
      createDefaultSessionRecallResolver(),
    ];
    for (const resolver of resolvers) {
      const resolution = await resolver.resolve({
        state: this.kernel,
        messages,
        task,
        toolRecords,
        responseRequirements: requirements,
      });
      if (resolution) {
        return {
          answer: resolution.answer,
          confidence: resolution.confidence,
          filesRead: resolution.filesRead ?? [],
        };
      }
    }
    return null;
  }

  async projectPrompt(messages: LLMMessage[]): Promise<string> {
    if (!this.kernel) {
      return '';
    }
    const responseRequirements = await this.selectResponseRequirements(this.kernel, messages);
    const selection = await this.selectPromptContext(this.kernel, messages, responseRequirements);
    const promptProjectors = [
      createRepositoryContextProjector(),
      ...(this.activeProfile?.promptProjectors ?? []),
      ...this.sdk.promptProjectors,
    ];
    return projectKernelPrompt(this.kernel, messages, promptProjectors, selection, {
      repositoryModel: this.repositoryModel,
      toolCapabilities: this.activeToolCapabilities,
    });
  }

  async recordEvent(event: AgentEvent): Promise<void> {
    if (!this.kernel?.sessionId) {
      return;
    }
    const sessionId = this.kernel.sessionId;
    if (event.type === 'tool:start') {
      this.pendingToolInputs.set(
        event.toolCallId || `${event.runId || 'run'}:${event.data.toolName}`,
        {
          toolName: event.data.toolName,
          input: normalizeToolInput(event.data.input),
        },
      );
    }
    if (event.type === 'tool:end') {
      const toolName = event.data.toolName;
      if (shouldRefreshKernelFromStore(toolName)) {
        const persisted = await this.store.loadKernelState(sessionId);
        if (persisted) {
          this.kernel = persisted;
        }
      }
      const pendingKey = event.toolCallId || `${event.runId || 'run'}:${toolName}`;
      const pending = this.pendingToolInputs.get(pendingKey);
      const input = pending?.input ?? {};
      this.pendingToolInputs.delete(pendingKey);
      const toolInputSummary = summarizeToolInput(toolName, input);
      const summary = typeof event.data.output === 'string'
        ? event.data.output
        : event.data.metadata?.summary
          ? String(event.data.metadata.summary)
          : `${toolName} completed`;
      const metadata = event.data.metadata
        ? event.data.metadata as unknown as Record<string, unknown>
        : undefined;
      const shouldPromote = shouldPromoteToolEvidence(toolName, summary, metadata, input, event.data.success);
      const evidenceSummary = shouldPromote
        ? buildKernelEvidenceSummary(toolName, summary, metadata, input, toolInputSummary)
        : '';
      const artifact: ToolResultArtifact = {
        status: event.data.success ? 'success' : 'error',
        summary,
        artifact: {
          ...metadata,
          toolName,
          toolInputSummary,
        },
        evidence: shouldPromote ? [{
          id: `ev-${event.timestamp}-${toolName}`,
          summary: summarizeToolEvidence(evidenceSummary, toolInputSummary),
          source: toolName,
          createdAt: event.timestamp,
          toolName,
          toolInputSummary,
          artifact: metadata,
          filePaths: extractFilePaths(metadata),
          pinned: shouldPinToolEvidence(toolName, input),
        }] : [],
        mutations: {
          filesRead: extractFilePaths(metadata),
        },
      };
      this.kernel = recordToolArtifact(this.kernel, artifact);
      if (event.data.success && (toolName === 'memory_correction' || toolName === 'memory_constraint')) {
        this.kernel = completePendingActions(this.kernel, isCorrectionPendingAction);
      }
      const record: ToolCallRecord = {
        id: event.toolCallId || `tool-${Date.now()}`,
        sessionId,
        runId: event.runId,
        timestamp: event.timestamp,
        toolName,
        input,
        artifact,
      };
      await this.store.appendToolRecord(sessionId, record);
      for (const observer of this.sdk.observers) {
        await observer.onToolCall?.(record);
      }
    }
    if (event.type === 'status:change') {
      const message = typeof event.data?.message === 'string' ? event.data.message : '';
      if (/correction/i.test(message)) {
        this.kernel = recordCorrection(this.kernel, message);
      }
    }
    await this.store.saveKernelState(sessionId, this.kernel);
  }

  async completeRun(input: {
    sessionId: string;
    runId?: string;
    mode?: AgentMode;
    summary: string;
    filesRead?: string[];
    filesModified?: string[];
    filesCreated?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<RunCompletionResult> {
    if (!this.kernel) {
      return {
        persisted: false,
        validationResults: [],
        artifactResults: [],
        blockedByPolicy: false,
      };
    }
    const validationResults = await Promise.all(
      (this.activeProfile?.outputValidators ?? []).map((validator) =>
        validator.validate({
          state: this.kernel!,
          answer: input.summary,
          mode: resolveRuntimeMode(input.mode),
          metadata: input.metadata,
        }),
      ),
    );
    const normalizedValidationResults = validationResults.filter(
      (result): result is NonNullable<typeof result> => Boolean(result),
    );
    const blockedByPolicy =
      (this.activeProfile?.completionPolicy?.requireValidatorsToPass ?? false)
      && normalizedValidationResults.some((result) => result.verdict === 'block');
    if (blockedByPolicy) {
      return {
        persisted: false,
        validationResults: normalizedValidationResults,
        artifactResults: [],
        blockedByPolicy: true,
      };
    }
    this.kernel = summarizeAssistantTurn(this.kernel, input.summary);
    const handoff: RunHandoff = {
      runId: input.runId || `run-${Date.now()}`,
      mode: resolveRuntimeMode(input.mode),
      createdAt: new Date().toISOString(),
      summary: input.summary,
      filesRead: input.filesRead,
      filesModified: input.filesModified,
      filesCreated: input.filesCreated,
    };
    this.kernel = recordRunHandoff(this.kernel, handoff);
    await this.store.appendTurn(input.sessionId, {
      id: `turn-assistant-${Date.now()}`,
      sessionId: input.sessionId,
      runId: input.runId,
      role: 'assistant',
      content: input.summary,
      timestamp: new Date().toISOString(),
    });
    await this.store.appendRunRecord(input.sessionId, {
      runId: handoff.runId,
      mode: handoff.mode,
      summary: handoff.summary,
      createdAt: handoff.createdAt,
      filesRead: handoff.filesRead,
      filesModified: handoff.filesModified,
      filesCreated: handoff.filesCreated,
    });
    const [turnCount, toolCallCount] = await Promise.all([
      this.store.countArtifactLines(input.sessionId, 'turns.jsonl'),
      this.store.countArtifactLines(input.sessionId, 'tool-ledger.jsonl'),
    ]);
    const narrativeSummary = await generateNarrativeRollupSummary(this.kernel, {
      turnCount,
      toolCallCount,
    });
    this.kernel = compactKernelState(this.kernel, {
      turnCount,
      toolCallCount,
      narrativeSummary,
    });
    await this.store.saveKernelState(input.sessionId, this.kernel);
    const artifactResults = await Promise.all(
      (this.activeProfile?.artifactWriters ?? []).map((writer) =>
        writer.write({
          state: this.kernel!,
          sessionId: input.sessionId,
          summary: input.summary,
          runId: input.runId,
          metadata: input.metadata,
        }),
      ),
    );
    for (const observer of this.sdk.observers) {
      await observer.onKernelUpdated?.(this.kernel);
    }
    return {
      persisted: true,
      validationResults: normalizedValidationResults,
      artifactResults,
      blockedByPolicy: false,
    };
  }

  private async interpretTurn(input: {
    sessionId?: string;
    mode: AgentMode | 'assistant' | 'autonomous';
    message: string;
    kernel: KernelState | null;
  }): Promise<TurnInterpretation | null> {
    const interpreters = [
      ...this.sdk.turnInterpreters.filter((interpreter) => interpreter.supports(input.mode)),
      createDefaultTurnInterpreter(),
    ];
    let best: TurnInterpretation | null = null;
    for (const interpreter of interpreters) {
      const result = await interpreter.interpret(input);
      if (!result) {
        continue;
      }
      if (!best || result.confidence > best.confidence) {
        best = result;
      }
      if (result.confidence >= 0.9) {
        return result;
      }
    }
    return best;
  }

  private async selectPromptContext(
    state: KernelState,
    messages: LLMMessage[],
    responseRequirements?: RuntimeResponseRequirements,
  ): Promise<PromptContextSelection> {
    const selectors = [
      ...(this.activeProfile?.promptContextSelectors ?? []),
      ...this.sdk.promptContextSelectors,
      createDefaultPromptContextSelector(),
    ];
    let selected: PromptContextSelection | null = null;
    for (const selector of selectors) {
      const result = await selector.select({ state, messages, responseRequirements });
      if (result) {
        selected = result;
      }
    }
    if (!selected) {
      throw new Error('Prompt context selection failed to produce a result');
    }
    return selected;
  }

  private async selectResponseRequirements(
    state: KernelState,
    messages: LLMMessage[],
  ): Promise<RuntimeResponseRequirements> {
    const task = getCurrentTaskForMessages(state, messages);
    const selectors = [
      ...(this.activeProfile?.responseRequirementsSelectors ?? []),
      ...this.sdk.responseRequirementsSelectors,
      createDefaultResponseRequirementsSelector(),
    ];
    let selected: RuntimeResponseRequirements | null = null;
    for (const selector of selectors) {
      const result = await selector.select({ state, messages, task });
      if (!selected || result.requirements.maxUnsupportedClaims < selected.requirements.maxUnsupportedClaims) {
        selected = result;
      }
    }
    this.lastResponseRequirements = selected;
    return selected ?? {
      requirements: {
        allowsMemoryOnlyRecall: true,
        needsDirectToolEvidence: false,
        needsFileBackedClaims: false,
        allowsInference: true,
        maxUnsupportedClaims: 1,
      },
      rationale: 'Default runtime response requirements.',
    };
  }

  private async describeRepository(input: {
    workingDir: string;
    mode: AgentMode | 'assistant' | 'autonomous';
    profile: RuntimeProfile | null;
    kernel: KernelState | null;
  }): Promise<RepositoryModel | null> {
    const providers = [
      createDefaultRepositoryDiagnosticsProvider({
        probes: [
          ...createBuiltInRepositoryProbes(),
          ...this.sdk.repositoryProbes,
          ...(input.profile?.repositoryProbes ?? []),
        ],
      }),
      ...this.sdk.repositoryDiagnosticsProviders,
      ...(input.profile?.repositoryDiagnosticsProviders ?? []),
    ];
    let model: RepositoryModel | null = null;
    for (const provider of providers) {
      const next = await provider.describe(input);
      if (!next) {
        continue;
      }
      model = model ? mergeRepositoryModels(model, next) : next;
    }
    return model;
  }

  private async resolveToolCapabilities(input: {
    workingDir: string;
    mode: AgentMode | 'assistant' | 'autonomous';
    profile: RuntimeProfile | null;
    repositoryModel: RepositoryModel | null;
    kernel: KernelState | null;
  }): Promise<ToolCapability[]> {
    const resolvers = [
      createDefaultToolCapabilityResolver(),
      ...this.sdk.toolCapabilityResolvers,
      ...(input.profile?.toolCapabilityResolvers ?? []),
    ];
    const capabilities = new Set<ToolCapability>();
    for (const resolver of resolvers) {
      const resolved = await resolver.resolve(input);
      for (const capability of resolved ?? []) {
        capabilities.add(capability);
      }
    }
    const blocked = new Set(input.profile?.toolPolicy?.blockedCapabilities ?? []);
    const allowed = input.profile?.toolPolicy?.allowedCapabilities;
    const filtered = Array.from(capabilities).filter((capability) => !blocked.has(capability));
    return allowed?.length
      ? filtered.filter((capability) => allowed.includes(capability))
      : filtered;
  }
}

function normalizeInterpretationPersistence(
  interpretation: TurnInterpretation | null,
  hasExistingSession: boolean,
): TurnInterpretation | null {
  if (!interpretation || !interpretation.shouldPersist || interpretation.persistStrategy) {
    return interpretation;
  }

  return {
    ...interpretation,
    persistStrategy: hasExistingSession ? 'explicit_commit' : 'record_directly',
  };
}

function mergeRepositoryModels(
  base: RepositoryModel,
  next: RepositoryModel,
): RepositoryModel {
  return {
    topology: next.topology !== 'unknown' ? next.topology : base.topology,
    stack: {
      languages: uniqueArray([...base.stack.languages, ...next.stack.languages]),
      frameworks: uniqueArray([...base.stack.frameworks, ...next.stack.frameworks]),
      runtimes: uniqueArray([...base.stack.runtimes, ...next.stack.runtimes]),
      packageManagers: uniqueArray([...base.stack.packageManagers, ...next.stack.packageManagers]),
      buildTools: uniqueArray([...base.stack.buildTools, ...next.stack.buildTools]),
      testTools: uniqueArray([...base.stack.testTools, ...next.stack.testTools]),
    },
    fingerprints: mergeFingerprints(base.fingerprints, next.fingerprints),
    workspace: {
      rootPath: next.workspace.rootPath || base.workspace.rootPath,
      packageRoots: uniqueArray([...base.workspace.packageRoots, ...next.workspace.packageRoots]),
      appRoots: uniqueArray([...base.workspace.appRoots, ...next.workspace.appRoots]),
      libraryRoots: uniqueArray([...base.workspace.libraryRoots, ...next.workspace.libraryRoots]),
      infraRoots: uniqueArray([...base.workspace.infraRoots, ...next.workspace.infraRoots]),
      docsRoots: uniqueArray([...base.workspace.docsRoots, ...next.workspace.docsRoots]),
    },
    conventions: {
      hasAdr: base.conventions.hasAdr || next.conventions.hasAdr,
      hasOpenApi: base.conventions.hasOpenApi || next.conventions.hasOpenApi,
      hasCi: base.conventions.hasCi || next.conventions.hasCi,
      hasLinting: base.conventions.hasLinting || next.conventions.hasLinting,
      hasFormatting: base.conventions.hasFormatting || next.conventions.hasFormatting,
    },
    riskSignals: uniqueArray([...base.riskSignals, ...next.riskSignals]),
    detectedAt: next.detectedAt,
    sources: uniqueArray([...base.sources, ...next.sources]),
  };
}

function mergeFingerprints(
  base: RepositoryFingerprints,
  next: RepositoryFingerprints,
): RepositoryFingerprints {
  return {
    ecosystems: mergeSignalLists(base.ecosystems, next.ecosystems),
    languages: mergeSignalLists(base.languages, next.languages),
    frameworks: mergeSignalLists(base.frameworks, next.frameworks),
    runtimes: mergeSignalLists(base.runtimes, next.runtimes),
    packageManagers: mergeSignalLists(base.packageManagers, next.packageManagers),
    buildTools: mergeSignalLists(base.buildTools, next.buildTools),
    testTools: mergeSignalLists(base.testTools, next.testTools),
  };
}

function mergeSignalLists(
  base: RepositorySignal[],
  next: RepositorySignal[],
): RepositorySignal[] {
  const merged = new Map<string, RepositorySignal>();
  for (const signal of [...base, ...next]) {
    const current = merged.get(signal.name);
    if (!current || signal.confidence > current.confidence) {
      merged.set(signal.name, {
        ...signal,
        sources: uniqueArray([...(current?.sources ?? []), ...signal.sources]),
      });
    } else {
      current.sources = uniqueArray([...current.sources, ...signal.sources]);
    }
  }
  return Array.from(merged.values()).sort((left, right) => right.confidence - left.confidence || left.name.localeCompare(right.name));
}

function getCurrentTaskForMessages(state: KernelState, messages: LLMMessage[]): string {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  return typeof lastUserMessage?.content === 'string'
    ? lastUserMessage.content
    : state.currentTask;
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function uniqueArray<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function createRepositoryContextProjector() {
  return {
    id: 'repository-context-projector',
    project(input: {
      repositoryModel?: RepositoryModel | null;
      toolCapabilities?: ToolCapability[];
    }): string {
      const model = input.repositoryModel;
      if (!model) {
        return '';
      }

      const lines: string[] = ['# Repository Context'];
      lines.push(`- Topology: ${model.topology}`);

      const primarySignals = [
        model.fingerprints.ecosystems[0],
        model.fingerprints.languages[0],
      ].filter(Boolean) as RepositorySignal[];
      if (primarySignals.length > 0) {
        lines.push(
          `- Primary signals: ${primarySignals.map((signal) => `${signal.name} (${signal.confidence.toFixed(2)})`).join(', ')}`,
        );
      }

      if (model.stack.frameworks.length > 0) {
        lines.push(`- Frameworks: ${model.stack.frameworks.join(', ')}`);
      }
      if (model.stack.packageManagers.length > 0) {
        lines.push(`- Package managers: ${model.stack.packageManagers.join(', ')}`);
      }
      if (model.stack.buildTools.length > 0) {
        lines.push(`- Build tools: ${model.stack.buildTools.join(', ')}`);
      }
      if ((input.toolCapabilities ?? []).length > 0) {
        lines.push(`- Active tool capabilities: ${input.toolCapabilities?.join(', ')}`);
      }
      if (model.workspace.appRoots.length > 0 || model.workspace.packageRoots.length > 0 || model.workspace.libraryRoots.length > 0) {
        const layoutParts = [
          ...(model.workspace.packageRoots.length > 0 ? [`packages=${model.workspace.packageRoots.length}`] : []),
          ...(model.workspace.appRoots.length > 0 ? [`apps=${model.workspace.appRoots.length}`] : []),
          ...(model.workspace.libraryRoots.length > 0 ? [`libs=${model.workspace.libraryRoots.length}`] : []),
        ];
        if (layoutParts.length > 0) {
          lines.push(`- Workspace layout: ${layoutParts.join(', ')}`);
        }
      }

      return lines.join('\n');
    },
  };
}

function extractFilePaths(metadata?: Record<string, unknown>): string[] | undefined {
  const direct = metadata?.filePath;
  if (typeof direct === 'string' && direct.trim()) {
    return [direct];
  }
  const paths = metadata?.filePaths;
  if (Array.isArray(paths)) {
    const normalized = paths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return normalized.length > 0 ? normalized : undefined;
  }
  return undefined;
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string | undefined {
  if (typeof input.command === 'string' && input.command.trim()) {
    return input.command;
  }
  if (typeof input.path === 'string' && input.path.trim()) {
    return input.path;
  }
  if (typeof input.pattern === 'string' && input.pattern.trim()) {
    return input.pattern;
  }
  if (typeof input.query === 'string' && input.query.trim()) {
    return input.query;
  }
  if (typeof input.filePath === 'string' && input.filePath.trim()) {
    return input.filePath;
  }
  const firstPrimitive = Object.entries(input).find(([, value]) =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
  );
  if (firstPrimitive) {
    return `${firstPrimitive[0]}=${String(firstPrimitive[1])}`;
  }
  return toolName;
}

function summarizeToolEvidence(summary: string, toolInputSummary?: string): string {
  if (!summary.trim()) {
    return toolInputSummary ? `Executed ${toolInputSummary}` : 'Tool executed successfully';
  }
  return summary;
}

function shouldPromoteToolEvidence(
  toolName: string,
  summary: string,
  metadata: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
  success: boolean,
): boolean {
  if (toolName === 'report') {
    return false;
  }
  if (!success && toolName !== 'memory_correction' && toolName !== 'memory_constraint' && toolName !== 'shell_exec') {
    return false;
  }
  if (typeof metadata?.filePath === 'string' || Array.isArray(metadata?.filePaths)) {
    return true;
  }
  if (typeof input.command === 'string' && input.command.trim()) {
    return true;
  }
  if (typeof input.path === 'string' && input.path.trim()) {
    return true;
  }
  return summary.trim().length > 0;
}

const MAX_EVIDENCE_SUMMARY_CHARS = 240;

function buildKernelEvidenceSummary(
  toolName: string,
  summary: string,
  metadata: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
  toolInputSummary?: string,
): string {
  if (toolName === 'fs_read') {
    const filePath = typeof metadata?.filePath === 'string' ? metadata.filePath : toolInputSummary;
    const readFrom = typeof metadata?.readFrom === 'number' ? metadata.readFrom : undefined;
    const readTo = typeof metadata?.readTo === 'number' ? metadata.readTo : undefined;
    const totalLines = typeof metadata?.totalLines === 'number' ? metadata.totalLines : undefined;
    const range = readFrom && readTo ? ` lines ${readFrom}-${readTo}` : '';
    const total = totalLines ? ` of ${totalLines}` : '';
    return truncateEvidenceSummary(`Read ${filePath ?? 'file'}${range}${total}.`, MAX_EVIDENCE_SUMMARY_CHARS);
  }

  if (toolName === 'grep_search') {
    const matches = typeof metadata?.totalMatches === 'number' ? metadata.totalMatches : undefined;
    const pattern = toolInputSummary ?? 'pattern';
    const base = matches !== undefined
      ? `Found ${matches} match(es) for "${pattern}".`
      : `Searched for "${pattern}".`;
    const refs = extractMatchReferences(summary, 3);
    return truncateEvidenceSummary(refs.length > 0 ? `${base} Top refs: ${refs.join(', ')}` : base, MAX_EVIDENCE_SUMMARY_CHARS);
  }

  if (toolName === 'fs_list') {
    const targetPath = typeof metadata?.path === 'string' ? metadata.path : toolInputSummary;
    const directories = typeof metadata?.directoryCount === 'number' ? metadata.directoryCount : undefined;
    const files = typeof metadata?.fileCount === 'number' ? metadata.fileCount : undefined;
    return truncateEvidenceSummary(
      `Listed ${targetPath ?? 'directory'}${directories !== undefined || files !== undefined ? ` (${directories ?? 0} dirs, ${files ?? 0} files)` : ''}.`,
      MAX_EVIDENCE_SUMMARY_CHARS,
    );
  }

  if (toolName === 'shell_exec') {
    const compactOutput = compactMultilineSummary(summary, 4);
    const base = toolInputSummary ? `Command ${toolInputSummary}` : 'Shell command';
    return truncateEvidenceSummary(`${base} -> ${compactOutput}`, MAX_EVIDENCE_SUMMARY_CHARS);
  }

  if (toolName === 'memory_correction' || toolName === 'memory_constraint') {
    return truncateEvidenceSummary(summary, MAX_EVIDENCE_SUMMARY_CHARS);
  }

  return truncateEvidenceSummary(summary, MAX_EVIDENCE_SUMMARY_CHARS);
}

function truncateEvidenceSummary(summary: string, maxChars: number): string {
  const normalized = summary.replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function compactMultilineSummary(summary: string, maxLines: number): string {
  const lines = summary
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines);
  return lines.join(' | ');
}

function extractMatchReferences(summary: string, limit: number): string[] {
  const refs = summary
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /:\d+/.test(line) && !line.startsWith('['))
    .slice(0, limit);
  return refs;
}

function shouldPinToolEvidence(toolName: string, input: Record<string, unknown>): boolean {
  return toolName === 'shell_exec' && typeof input.command === 'string' && input.command.trim().length > 0;
}

function shouldRefreshKernelFromStore(toolName: string): boolean {
  return toolName === 'memory_correction' || toolName === 'memory_constraint';
}

async function generateNarrativeRollupSummary(
  kernel: KernelState,
  stats: {
    turnCount: number;
    toolCallCount: number;
  },
): Promise<string | undefined> {
  if (!shouldGenerateNarrativeRollup(kernel, stats)) {
    return undefined;
  }

  const fallback = createDeterministicNarrativeSummary(kernel, stats);
  const llm = useLLM({ tier: 'small' });
  if (!llm?.complete) {
    return fallback;
  }

  try {
    const response = await llm.complete(
      buildRollupPrompt(kernel, stats),
      {
        systemPrompt: [
          'Write a compact session rollup for an AI coding agent.',
          'Use only the provided structured state.',
          'Do not invent facts.',
          'Mention only durable context that helps the next turn.',
          'Keep it under 90 words.',
        ].join(' '),
        temperature: 0.1,
        maxTokens: 140,
      },
    );
    const text = response.content.trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

function shouldGenerateNarrativeRollup(
  kernel: KernelState,
  stats: {
    turnCount: number;
    toolCallCount: number;
  },
): boolean {
  return stats.turnCount >= 8 || stats.toolCallCount >= 6 || kernel.memory.evidence.length >= 6;
}

function buildRollupPrompt(
  kernel: KernelState,
  stats: {
    turnCount: number;
    toolCallCount: number;
  },
): string {
  const sections = [
    `Objective: ${kernel.objective ?? kernel.currentTask}`,
    `Session stats: ${stats.turnCount} turns, ${stats.toolCallCount} tool calls`,
  ];

  if (kernel.constraints.length > 0) {
    sections.push(`Constraints:\n- ${kernel.constraints.join('\n- ')}`);
  }
  const corrections = kernel.memory.corrections.slice(-3).map((item) => item.content);
  if (corrections.length > 0) {
    sections.push(`Corrections:\n- ${corrections.join('\n- ')}`);
  }
  const decisions = kernel.memory.decisions.slice(-3).map((item) => item.content);
  if (decisions.length > 0) {
    sections.push(`Decisions:\n- ${decisions.join('\n- ')}`);
  }
  const evidence = kernel.memory.evidence
    .slice(-4)
    .map((item) => `${item.toolName ?? item.source}${item.toolInputSummary ? ` (${item.toolInputSummary})` : ''}: ${item.summary}`);
  if (evidence.length > 0) {
    sections.push(`Evidence:\n- ${evidence.join('\n- ')}`);
  }
  if (kernel.handoff?.summary) {
    sections.push(`Latest handoff:\n${kernel.handoff.summary}`);
  }

  return sections.join('\n\n');
}

function createDeterministicNarrativeSummary(
  kernel: KernelState,
  stats: {
    turnCount: number;
    toolCallCount: number;
  },
): string {
  const parts = [
    `Long session in progress with ${stats.turnCount} turns and ${stats.toolCallCount} tool calls.`,
  ];
  if (kernel.constraints.length > 0) {
    parts.push(`Keep honoring constraints: ${kernel.constraints.join('; ')}.`);
  }
  const anchors = kernel.memory.evidence
    .slice(-2)
    .map((item) => `${item.toolName ?? item.source}${item.toolInputSummary ? ` (${item.toolInputSummary})` : ''}`);
  if (anchors.length > 0) {
    parts.push(`Most recent anchors: ${anchors.join('; ')}.`);
  }
  if (kernel.handoff?.summary) {
    parts.push(`Latest outcome: ${kernel.handoff.summary}`);
  }
  return parts.join(' ');
}
