import type {
  AssumptionRecord,
  CorrectionRecord,
  DecisionRecord,
  EvidenceRecord,
  KernelState,
  MemoryRollup,
  OpenQuestionRecord,
  PendingActionRecord,
  PromptContextSelection,
  RepositoryModel,
  RoutingHints,
  RunHandoff,
  KernelMemoryState,
  ToolCapability,
  ToolResultArtifact,
  TurnInterpretation,
} from '../contracts/index.js';
import type { MemoryCapability, PromptProjector } from '../sdk/index.js';
import type { LLMMessage } from '@kb-labs/sdk';

function now(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const MAX_EVIDENCE_ITEMS = 12;
const MAX_DECISION_ITEMS = 10;
const MAX_COMPACTED_EVIDENCE_ITEMS = 8;
const MAX_COMPACTED_DONE_ACTIONS = 2;
const MAX_COMPACTED_CHILD_RESULTS = 5;
const CORRECTION_PENDING_PREFIX = 'Persist user correction via memory_correction:';

function createMemory(): KernelMemoryState {
  return {
    corrections: [],
    assumptions: [],
    decisions: [],
    evidence: [],
    openQuestions: [],
    pendingActions: [],
  };
}

export function createKernelState(input: {
  sessionId: string;
  workingDir: string;
  mode: KernelState['mode'];
  task: string;
}): KernelState {
  const timestamp = now();
  return {
    version: 1,
    sessionId: input.sessionId,
    workingDir: input.workingDir,
    mode: input.mode,
    currentTask: input.task,
    objective: input.task,
    constraints: [],
    memory: createMemory(),
    childResults: [],
    updatedAt: timestamp,
  };
}

function touch(state: KernelState): KernelState {
  return { ...state, updatedAt: now() };
}

function upsertSummary(state: KernelState, summary: string): KernelState {
  return {
    ...state,
    memory: {
      ...state.memory,
      latestSummary: summary,
    },
  };
}

export function ingestUserTurn(
  state: KernelState,
  input: string | { content: string; interpretation?: TurnInterpretation | null },
): KernelState {
  const content = typeof input === 'string' ? input : input.content;
  const interpretation = typeof input === 'string' ? null : input.interpretation ?? null;
  let nextState: KernelState = {
    ...state,
    currentTask: content,
    objective: state.objective || content,
  };

  if (interpretation) {
    nextState = recordRoutingHints(nextState, interpretation);
  }

  if (interpretation?.shouldPersist && interpretation.content) {
    if (interpretation.persistStrategy === 'record_directly') {
      nextState = persistInterpretedMemory(nextState, interpretation);
    } else {
      nextState = ensurePendingCorrectionAction(nextState, interpretation.content);
    }
  }

  return touch(nextState);
}

export function recordConstraint(
  state: KernelState,
  content: string,
): KernelState {
  if (!content.trim()) {
    return state;
  }
  if (state.constraints.includes(content.trim())) {
    return state;
  }
  return touch({
    ...state,
    constraints: [...state.constraints, content.trim()],
  });
}

export function recordCorrection(
  state: KernelState,
  content: string,
  invalidates: string[] = [],
): KernelState {
  const record: CorrectionRecord = {
    id: makeId('corr'),
    content,
    timestamp: now(),
    invalidates,
    source: 'user',
  };

  const assumptions = state.memory.assumptions.map((item) =>
    invalidates.includes(item.id)
      ? {
          ...item,
          status: 'invalidated' as const,
          invalidatedAt: record.timestamp,
          invalidatedBy: record.id,
        }
      : item,
  );

  return touch({
    ...state,
    memory: {
      ...state.memory,
      corrections: [...state.memory.corrections, record],
      assumptions,
    },
  });
}

export function recordAssumption(
  state: KernelState,
  content: string,
): KernelState {
  const assumption: AssumptionRecord = {
    id: makeId('asm'),
    content,
    status: 'active',
    createdAt: now(),
  };
  return touch({
    ...state,
    memory: {
      ...state.memory,
      assumptions: [...state.memory.assumptions, assumption],
    },
  });
}

export function recordDecision(
  state: KernelState,
  content: string,
  source: DecisionRecord['source'] = 'agent',
): KernelState {
  const decision: DecisionRecord = {
    id: makeId('dec'),
    content,
    source,
    createdAt: now(),
  };
  return touch({
    ...state,
    memory: {
      ...state.memory,
      decisions: [...state.memory.decisions, decision].slice(-MAX_DECISION_ITEMS),
    },
  });
}

export function recordOpenQuestion(
  state: KernelState,
  content: string,
): KernelState {
  const question: OpenQuestionRecord = {
    id: makeId('q'),
    content,
    createdAt: now(),
    status: 'open',
  };
  return touch({
    ...state,
    memory: {
      ...state.memory,
      openQuestions: [...state.memory.openQuestions, question],
    },
  });
}

export function recordPendingAction(
  state: KernelState,
  content: string,
  status: PendingActionRecord['status'] = 'pending',
): KernelState {
  const action: PendingActionRecord = {
    id: makeId('todo'),
    content,
    createdAt: now(),
    status,
  };
  return touch({
    ...state,
    memory: {
      ...state.memory,
      pendingActions: [...state.memory.pendingActions, action],
    },
  });
}

export function completePendingActions(
  state: KernelState,
  predicate: (action: PendingActionRecord) => boolean,
): KernelState {
  let changed = false;
  const pendingActions = state.memory.pendingActions.map((action) => {
    if (action.status !== 'done' && predicate(action)) {
      changed = true;
      return { ...action, status: 'done' as const };
    }
    return action;
  });
  return changed
    ? touch({
        ...state,
        memory: {
          ...state.memory,
          pendingActions,
        },
      })
    : state;
}

export function recordToolArtifact(
  state: KernelState,
  artifact: ToolResultArtifact,
): KernelState {
  const evidence = artifact.evidence.filter((item) => item.summary.trim() || item.toolInputSummary?.trim());
  if (evidence.length === 0) {
    return state;
  }

  const deduped = [...state.memory.evidence, ...evidence].filter((item, index, all) => {
    const key = `${item.toolName ?? item.source}:${item.toolInputSummary ?? ''}:${item.summary}`;
    return all.findIndex((candidate) =>
      `${candidate.toolName ?? candidate.source}:${candidate.toolInputSummary ?? ''}:${candidate.summary}` === key,
    ) === index;
  });
  const pinned = deduped.filter((item) => item.pinned);
  const recent = deduped.filter((item) => !item.pinned).slice(-MAX_EVIDENCE_ITEMS);
  const merged = [...pinned, ...recent].slice(-MAX_EVIDENCE_ITEMS);

  return touch({
    ...state,
    memory: {
      ...state.memory,
      evidence: merged,
    },
  });
}

export function recordRunHandoff(
  state: KernelState,
  handoff: RunHandoff,
): KernelState {
  return touch({
    ...state,
    handoff,
    childResults: state.childResults,
  });
}

export function recordRoutingHints(
  state: KernelState,
  interpretation: TurnInterpretation,
): KernelState {
  const hasHints = Boolean(
    interpretation.suggestedMode
      || interpretation.suggestedPromptProfile
      || interpretation.suggestedSkills?.length
      || interpretation.suggestedToolCapabilities?.length,
  );
  if (!hasHints) {
    return state;
  }

  const routingHints: RoutingHints = {
    suggestedMode: interpretation.suggestedMode,
    suggestedSkills: interpretation.suggestedSkills ?? [],
    suggestedPromptProfile: interpretation.suggestedPromptProfile,
    suggestedToolCapabilities: interpretation.suggestedToolCapabilities ?? [],
    source: 'turn_interpretation',
    confidence: interpretation.confidence,
    updatedAt: now(),
  };

  return touch({
    ...state,
    routingHints,
  });
}

export function recordChildResult(
  state: KernelState,
  result: RunHandoff,
): KernelState {
  return touch({
    ...state,
    childResults: [...state.childResults, result],
  });
}

export function compactKernelState(
  state: KernelState,
  stats?: {
    turnCount?: number;
    toolCallCount?: number;
    narrativeSummary?: string;
  },
): KernelState {
  const pinnedEvidence = state.memory.evidence.filter((item) => item.pinned);
  const recentEvidence = state.memory.evidence
    .filter((item) => !item.pinned)
    .filter((item) => !isNoiseEvidence(item, state))
    .slice(-MAX_COMPACTED_EVIDENCE_ITEMS);
  const compactedEvidence = [...pinnedEvidence, ...recentEvidence]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(-MAX_EVIDENCE_ITEMS);

  const activeActions = state.memory.pendingActions.filter((item) => item.status !== 'done');
  const recentDoneActions = state.memory.pendingActions
    .filter((item) => item.status === 'done')
    .slice(-MAX_COMPACTED_DONE_ACTIONS);
  const pendingActions = [...activeActions, ...recentDoneActions];

  const childResults = state.childResults.slice(-MAX_COMPACTED_CHILD_RESULTS);
  const completedActionCount = state.memory.pendingActions.filter((item) => item.status === 'done').length;
  const prunedEvidenceCount = Math.max(0, state.memory.evidence.length - compactedEvidence.length);

  const rollup: MemoryRollup | undefined = shouldCreateRollup(state, stats)
    ? {
        generatedAt: now(),
        turnCount: stats?.turnCount,
        toolCallCount: stats?.toolCallCount,
        completedActionCount,
        prunedEvidenceCount,
        summary: createRollupSummary(state, {
          ...stats,
          completedActionCount,
          prunedEvidenceCount,
        }),
      }
    : state.rollup;

  return touch({
    ...state,
    rollup,
    childResults,
    memory: {
      ...state.memory,
      evidence: compactedEvidence,
      pendingActions,
    },
  });
}

export async function applyMemoryCapabilities(
  state: KernelState,
  capabilities: ReadonlyArray<MemoryCapability>,
): Promise<KernelState> {
  let nextState = state;
  for (const capability of capabilities) {
    nextState = await capability.apply(nextState);
  }
  return touch(nextState);
}

function defaultProjector(state: KernelState, _messages: LLMMessage[]): string {
  const selection = createDefaultPromptContextSelection(state);
  return renderPromptSections(state, selection);
}

function renderPromptSections(state: KernelState, selection: PromptContextSelection): string {
  const lines: string[] = [];
  if (selection.includeObjective && state.objective) {
    lines.push(`# Objective`, state.objective);
  }
  if (selection.includeSessionRollup && state.rollup?.summary) {
    lines.push('', '# Session Rollup', state.rollup.summary);
  }
  if (selection.includeConstraints && state.constraints.length > 0) {
    lines.push('', '# Constraints', ...state.constraints.map((item) => `- ${item}`));
  }
  if (selection.includeRoutingHints && state.routingHints) {
    const routingLines: string[] = [];
    if (state.routingHints.suggestedMode) {
      routingLines.push(`- Suggested mode: ${state.routingHints.suggestedMode}`);
    }
    if (state.routingHints.suggestedPromptProfile) {
      routingLines.push(`- Suggested prompt profile: ${state.routingHints.suggestedPromptProfile}`);
    }
    if (state.routingHints.suggestedSkills.length > 0) {
      routingLines.push(`- Suggested skills: ${state.routingHints.suggestedSkills.join(', ')}`);
    }
    if (state.routingHints.suggestedToolCapabilities.length > 0) {
      routingLines.push(`- Suggested tool capabilities: ${state.routingHints.suggestedToolCapabilities.join(', ')}`);
    }
    if (routingLines.length > 0) {
      lines.push('', '# Routing Hints', ...routingLines);
    }
  }
  const activeCorrections = state.memory.corrections.slice(-selection.correctionWindow);
  if (selection.includeCorrections && activeCorrections.length > 0) {
    lines.push('', '# Recent Corrections', ...activeCorrections.map((item) => `- ${item.content}`));
  }
  const decisions = state.memory.decisions.filter((item) => item.pinned).concat(
    state.memory.decisions.filter((item) => !item.pinned).slice(-selection.decisionWindow),
  ).slice(-selection.decisionWindow);
  if (selection.includeDecisions && decisions.length > 0) {
    lines.push('', '# Decisions', ...decisions.map((item) => `- ${item.content}`));
  }
  const evidence = state.memory.evidence.filter((item) => item.pinned).concat(
    state.memory.evidence.filter((item) => !item.pinned).slice(-selection.evidenceWindow),
  ).slice(-selection.evidenceWindow);
  if (selection.includeEvidence && evidence.length > 0) {
    lines.push(
      '',
      '# Evidence',
      ...evidence.map((item) => {
        const input = item.toolInputSummary ? ` (${item.toolInputSummary})` : '';
        const summary = item.summary || 'tool input captured';
        return `- ${item.toolName ?? item.source}${input}: ${summary}`;
      }),
    );
  }
  const previousRunToolEvidence = state.memory.evidence
    .filter((item) => item.toolName && item.toolInputSummary)
    .slice(-selection.toolUsageWindow);
  if (selection.includePreviousRunToolUsage && previousRunToolEvidence.length > 0) {
    lines.push(
      '',
      '# Previous Run Tool Usage',
      'For questions about previous runs, commands, or tool usage, treat this section as authoritative over plain assistant prose.',
      ...previousRunToolEvidence.map((item) => `- ${item.toolName}: ${item.toolInputSummary}`),
    );
  }
  if (selection.includePreviousRunHandoff && state.handoff?.summary) {
    lines.push('', '# Previous Run Handoff', state.handoff.summary);
  }
  if (selection.includeWorkingSummary && state.memory.latestSummary) {
    lines.push('', '# Working Summary', state.memory.latestSummary);
  }
  const relevantPendingActions = state.memory.pendingActions
    .filter((item) => item.status !== 'done')
    .slice(-selection.pendingActionWindow);
  if (selection.includePendingActions && relevantPendingActions.length > 0) {
    lines.push('', '# Pending Actions', ...relevantPendingActions.map((item) => `- ${item.content}`));
  }
  return lines.join('\n').trim();
}

export async function projectKernelPrompt(
  state: KernelState,
  messages: LLMMessage[],
  projectors: ReadonlyArray<PromptProjector>,
  selection?: PromptContextSelection | null,
  context?: {
    repositoryModel?: RepositoryModel | null;
    toolCapabilities?: ToolCapability[];
  },
): Promise<string> {
  const resolvedSelection = selection ?? createDefaultPromptContextSelection(state);
  const sections = [renderPromptSections(state, resolvedSelection)];
  for (const projector of projectors) {
    const extra = await projector.project({
      state,
      messages,
      repositoryModel: context?.repositoryModel ?? null,
      toolCapabilities: context?.toolCapabilities ?? [],
    });
    if (extra.trim()) {
      sections.push(extra.trim());
    }
  }
  return sections.filter(Boolean).join('\n\n');
}

export function summarizeAssistantTurn(
  state: KernelState,
  answer: string,
): KernelState {
  return touch(upsertSummary(state, answer.trim()));
}

function ensurePendingCorrectionAction(state: KernelState, correction: string): KernelState {
  const content = `${CORRECTION_PENDING_PREFIX} ${correction}`;
  const existing = state.memory.pendingActions.find((item) => item.content === content && item.status !== 'done');
  if (existing) {
    return state;
  }
  return recordPendingAction(state, content);
}

function persistInterpretedMemory(
  state: KernelState,
  interpretation: TurnInterpretation,
): KernelState {
  const content = interpretation.content?.trim();
  if (!content) {
    return state;
  }

  if (interpretation.persistenceKind === 'constraint') {
    let nextState = recordConstraint(state, content);
    if (!nextState.memory.corrections.some((item) => item.content === content)) {
      nextState = recordCorrection(nextState, content, interpretation.invalidates ?? []);
    }
    return nextState;
  }

  return recordCorrection(state, content, interpretation.invalidates ?? []);
}

export function isCorrectionPendingAction(action: PendingActionRecord): boolean {
  return action.content.startsWith(CORRECTION_PENDING_PREFIX);
}

export function createDefaultPromptContextSelection(state: KernelState): PromptContextSelection {
  return {
    includeObjective: true,
    includeSessionRollup: Boolean(state.rollup?.summary),
    includeConstraints: true,
    includeRoutingHints: true,
    includeCorrections: true,
    includeDecisions: true,
    includeEvidence: true,
    includePreviousRunToolUsage: true,
    includePreviousRunHandoff: true,
    includeWorkingSummary: true,
    includePendingActions: true,
    correctionWindow: state.rollup ? 3 : 5,
    decisionWindow: 5,
    evidenceWindow: state.rollup ? 4 : 6,
    toolUsageWindow: 3,
    pendingActionWindow: 5,
  };
}

function shouldCreateRollup(
  state: KernelState,
  stats?: {
    turnCount?: number;
    toolCallCount?: number;
  },
): boolean {
  return Boolean(
    (stats?.turnCount ?? 0) >= 8
      || (stats?.toolCallCount ?? 0) >= 6
      || state.memory.evidence.length >= 6
      || state.memory.pendingActions.length >= 6
      || state.childResults.length >= 4,
  );
}

function isNoiseEvidence(item: EvidenceRecord, state: KernelState): boolean {
  if (!item.toolName) {
    return false;
  }
  if ((item.toolName === 'memory_correction' || item.toolName === 'memory_constraint') && state.memory.corrections.length > 0) {
    return true;
  }
  if (item.toolName === 'report' && typeof item.artifact?.code === 'string' && item.artifact.code === 'PENDING_MEMORY_COMMIT') {
    return true;
  }
  return false;
}

function createRollupSummary(
  state: KernelState,
  stats: {
    turnCount?: number;
    toolCallCount?: number;
    completedActionCount: number;
    prunedEvidenceCount: number;
    narrativeSummary?: string;
  },
): string {
  const segments: string[] = [];
  if (stats.turnCount || stats.toolCallCount) {
    segments.push(`Session activity: ${stats.turnCount ?? 0} turns, ${stats.toolCallCount ?? 0} tool calls.`);
  }
  if (state.constraints.length > 0) {
    segments.push(`Active constraints: ${state.constraints.join('; ')}.`);
  }
  const recentDecisions = state.memory.decisions.slice(-2).map((item) => item.content);
  if (recentDecisions.length > 0) {
    segments.push(`Recent decisions: ${recentDecisions.join('; ')}.`);
  }
  const recentEvidence = state.memory.evidence
    .filter((item) => !isNoiseEvidence(item, state))
    .slice(-3)
    .map((item) => `${item.toolName ?? item.source}${item.toolInputSummary ? ` (${item.toolInputSummary})` : ''}`);
  if (recentEvidence.length > 0) {
    segments.push(`Recent evidence anchors: ${recentEvidence.join('; ')}.`);
  }
  if (stats.completedActionCount > 0 || stats.prunedEvidenceCount > 0) {
    segments.push(`Compaction kept continuity while collapsing ${stats.completedActionCount} completed action(s) and ${stats.prunedEvidenceCount} stale evidence item(s).`);
  }
  if (stats.narrativeSummary?.trim()) {
    segments.push(`Narrative summary: ${stats.narrativeSummary.trim()}`);
  }
  return segments.join(' ').trim();
}

export type { KernelState, ToolResultArtifact, EvidenceRecord };
