/** Stable, transport-neutral capabilities used by sub-agent presets. */
export const SUB_AGENT_CAPABILITIES = [
  'workspace.read',
  'workspace.write',
  'repository.search',
  'shell.execute',
  'memory.read',
  'memory.archive',
  'memory.write',
  'organization.read',
  'organization.write',
  'planning.write',
  'user.interaction',
  'task.report',
] as const;

export type SubAgentCapability = typeof SUB_AGENT_CAPABILITIES[number];

/** Canonical KB tool ID → capability mapping. Transports may expose different names. */
export const AGENT_TOOL_CAPABILITIES: Readonly<Record<string, readonly SubAgentCapability[]>> = {
  fs_read: ['workspace.read'],
  fs_list: ['workspace.read'],
  glob_search: ['repository.search'],
  grep_search: ['repository.search'],
  find_definition: ['repository.search'],
  code_stats: ['repository.search'],
  fs_write: ['workspace.write'],
  fs_patch: ['workspace.write'],
  fs_replace: ['workspace.write'],
  mass_replace: ['workspace.write'],
  shell_exec: ['shell.execute'],
  memory_get: ['memory.read'],
  memory_finding: ['memory.read'],
  archive_recall: ['memory.archive'],
  memory_blocker: ['memory.write'],
  memory_correction: ['memory.write'],
  todo_get: ['organization.read'],
  todo_create: ['organization.write'],
  todo_update: ['organization.write'],
  plan_write: ['planning.write'],
  ask_user: ['user.interaction'],
  report: ['task.report'],
};

export interface SubAgentToolPolicy {
  capabilities: readonly SubAgentCapability[];
  maxIterations: number;
}

/** Shared semantic policies; tool names are resolved from the canonical catalog. */
export const SUB_AGENT_PRESET_POLICIES = {
  research: {
    capabilities: ['workspace.read', 'repository.search', 'memory.read', 'memory.archive', 'organization.read', 'task.report'],
    maxIterations: 50,
  },
  execute: {
    capabilities: [
      'workspace.read', 'workspace.write', 'repository.search', 'shell.execute',
      'memory.read', 'memory.write', 'organization.read', 'organization.write',
      'planning.write', 'user.interaction', 'task.report',
    ],
    maxIterations: 100,
  },
  review: {
    capabilities: ['workspace.read', 'repository.search', 'shell.execute', 'memory.read', 'memory.archive', 'organization.read', 'task.report'],
    maxIterations: 50,
  },
  verification: {
    capabilities: ['workspace.read', 'repository.search', 'shell.execute', 'task.report'],
    maxIterations: 25,
  },
} as const satisfies Readonly<Record<string, SubAgentToolPolicy>>;

export interface ResolvedSubAgentToolPolicy {
  preset: string;
  capabilities: readonly SubAgentCapability[];
  allowedToolIds: readonly string[];
  maxIterations: number;
}

/** Resolve a preset once for every sub-agent dispatch path. */
export function resolveSubAgentToolPolicy(preset: string): ResolvedSubAgentToolPolicy | undefined {
  const policy = SUB_AGENT_PRESET_POLICIES[preset as keyof typeof SUB_AGENT_PRESET_POLICIES];
  if (!policy) { return undefined; }
  const allowed = new Set<SubAgentCapability>(policy.capabilities);
  const allowedToolIds = Object.entries(AGENT_TOOL_CAPABILITIES)
    .filter(([, capabilities]) => capabilities.some((capability) => allowed.has(capability)))
    .map(([toolId]) => toolId);

  return {
    preset,
    capabilities: policy.capabilities,
    allowedToolIds,
    maxIterations: policy.maxIterations,
  };
}
