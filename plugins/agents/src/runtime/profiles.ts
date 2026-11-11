import type { AgentMode } from '../contracts/index.js';
import type { AgentSDK, RuntimeProfile } from '../sdk/index.js';

export function resolveRuntimeMode(mode?: AgentMode): 'assistant' | 'autonomous' {
  return mode === 'execute' ? 'autonomous' : 'assistant';
}

export function createBuiltInRuntimeProfiles(): RuntimeProfile[] {
  return [
    {
      id: 'assistant-profile',
      mode: 'assistant',
      description: 'Dialogue-first profile for AI-assisted work with controlled tool usage.',
      toolPolicy: {
        access: 'controlled',
      },
      completionPolicy: {
        requireReportTool: true,
      },
    },
    {
      id: 'autonomous-profile',
      mode: 'autonomous',
      description: 'Execution-first profile for longer-running autonomous task completion.',
      toolPolicy: {
        access: 'aggressive',
      },
      completionPolicy: {
        requireReportTool: true,
      },
    },
  ];
}

export function resolveRuntimeProfile(
  sdk: AgentSDK,
  mode: AgentMode | 'assistant' | 'autonomous',
): RuntimeProfile {
  const candidates = [
    ...createBuiltInRuntimeProfiles().filter((profile) => profile.mode === mode),
    ...sdk.runtimeProfiles.filter((profile) => profile.mode === mode),
  ];

  if (candidates.length === 0) {
    throw new Error(`No runtime profile registered for mode "${mode}"`);
  }

  return mergeRuntimeProfiles(candidates);
}

function mergeRuntimeProfiles(profiles: RuntimeProfile[]): RuntimeProfile {
  const first = profiles[0];
  if (!first) {
    throw new Error('Cannot merge runtime profiles from an empty candidate set');
  }
  const rest = profiles.slice(1);
  let merged: RuntimeProfile = {
    id: first.id,
    mode: first.mode,
      description: first.description,
      toolPolicy: first.toolPolicy,
      repositoryDiagnosticsProviders: [...(first.repositoryDiagnosticsProviders ?? [])],
      repositoryProbes: [...(first.repositoryProbes ?? [])],
      toolCapabilityResolvers: [...(first.toolCapabilityResolvers ?? [])],
      completionPolicy: first.completionPolicy,
    promptContextSelectors: [...(first.promptContextSelectors ?? [])],
    responseRequirementsSelectors: [...(first.responseRequirementsSelectors ?? [])],
    promptProjectors: [...(first.promptProjectors ?? [])],
    sessionRecallResolvers: [...(first.sessionRecallResolvers ?? [])],
    runEvaluators: [...(first.runEvaluators ?? [])],
    resultMappers: [...(first.resultMappers ?? [])],
    outputValidators: [...(first.outputValidators ?? [])],
    artifactWriters: [...(first.artifactWriters ?? [])],
  };

  for (const profile of rest) {
    merged = {
      ...merged,
      ...profile,
      description: profile.description ?? merged.description,
      toolPolicy: mergeToolPolicies(merged.toolPolicy, profile.toolPolicy),
      repositoryDiagnosticsProviders: [
        ...(merged.repositoryDiagnosticsProviders ?? []),
        ...(profile.repositoryDiagnosticsProviders ?? []),
      ],
      repositoryProbes: [
        ...(merged.repositoryProbes ?? []),
        ...(profile.repositoryProbes ?? []),
      ],
      toolCapabilityResolvers: [
        ...(merged.toolCapabilityResolvers ?? []),
        ...(profile.toolCapabilityResolvers ?? []),
      ],
      completionPolicy: profile.completionPolicy ?? merged.completionPolicy,
      promptContextSelectors: [
        ...(merged.promptContextSelectors ?? []),
        ...(profile.promptContextSelectors ?? []),
      ],
      responseRequirementsSelectors: [
        ...(merged.responseRequirementsSelectors ?? []),
        ...(profile.responseRequirementsSelectors ?? []),
      ],
      promptProjectors: [
        ...(merged.promptProjectors ?? []),
        ...(profile.promptProjectors ?? []),
      ],
      sessionRecallResolvers: [
        ...(merged.sessionRecallResolvers ?? []),
        ...(profile.sessionRecallResolvers ?? []),
      ],
      runEvaluators: [
        ...(merged.runEvaluators ?? []),
        ...(profile.runEvaluators ?? []),
      ],
      resultMappers: [
        ...(merged.resultMappers ?? []),
        ...(profile.resultMappers ?? []),
      ],
      outputValidators: [
        ...(merged.outputValidators ?? []),
        ...(profile.outputValidators ?? []),
      ],
      artifactWriters: [
        ...(merged.artifactWriters ?? []),
        ...(profile.artifactWriters ?? []),
      ],
    };
  }

  return merged;
}

function mergeToolPolicies(
  base: RuntimeProfile['toolPolicy'],
  next: RuntimeProfile['toolPolicy'],
): RuntimeProfile['toolPolicy'] {
  if (!base) {
    return next;
  }
  if (!next) {
    return base;
  }

  return {
    access: next.access ?? base.access,
    allowedToolNames: mergeAllowedArrays(base.allowedToolNames, next.allowedToolNames),
    allowedCapabilities: mergeAllowedArrays(base.allowedCapabilities, next.allowedCapabilities),
    blockedCapabilities: uniqueArray([
      ...(base.blockedCapabilities ?? []),
      ...(next.blockedCapabilities ?? []),
    ]),
  };
}

function mergeAllowedArrays<T>(base?: T[], next?: T[]): T[] | undefined {
  if (!base && !next) {
    return undefined;
  }
  if (!base) {
    return uniqueArray(next ?? []);
  }
  if (!next) {
    return uniqueArray(base);
  }
  const nextSet = new Set(next);
  return uniqueArray(base.filter((item) => nextSet.has(item)));
}

function uniqueArray<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
