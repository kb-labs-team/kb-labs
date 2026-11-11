import type { ToolCapability, ToolResultArtifact } from '../contracts/index.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext, ToolExecutionEnvelope, ToolPolicy } from './types.js';
import { createToolRegistry } from './tools/index.js';

const DEFAULT_TOOL_CAPABILITIES: Record<string, ToolCapability[]> = {
  fs_write: ['filesystem'],
  fs_read: ['filesystem'],
  fs_patch: ['filesystem'],
  fs_list: ['filesystem'],
  mass_replace: ['filesystem'],
  glob_search: ['search'],
  grep_search: ['search'],
  list_files: ['search'],
  find_definition: ['code-navigation'],
  code_stats: ['search'],
  shell_exec: ['shell'],
  memory_get: ['memory'],
  memory_preference: ['memory'],
  memory_constraint: ['memory'],
  session_save: ['memory'],
  memory_correction: ['memory'],
  memory_finding: ['memory'],
  memory_blocker: ['memory'],
  archive_recall: ['memory'],
  todo_create: ['todo'],
  todo_update: ['todo'],
  todo_get: ['todo'],
  ask_user: ['interaction'],
  ask_parent: ['reporting'],
  report: ['reporting'],
  task_submit: ['delegation'],
  task_status: ['delegation'],
  task_collect: ['delegation'],
  plan_validate: ['planning'],
};

function toArtifact(toolName: string, result: {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}): ToolResultArtifact {
  const summary = result.output || result.error || `${toolName} completed`;
  return {
    status: result.success ? 'success' : 'error',
    summary,
    artifact: result.metadata,
    evidence: summary
      ? [{
          id: `ev-${Date.now()}-${toolName}`,
          summary,
          source: toolName,
          createdAt: new Date().toISOString(),
          artifact: result.metadata,
        }]
      : [],
    mutations: typeof result.metadata?.filePath === 'string'
      ? { filesRead: [result.metadata.filePath] }
      : undefined,
    followUpHints: typeof result.metadata?.summary === 'string'
      ? [String(result.metadata.summary)]
      : undefined,
  };
}

export class ToolGateway {
  private readonly registry: ToolRegistry;

  constructor(
    private readonly context: ToolContext,
    private readonly policies: ToolPolicy[] = [],
  ) {
    this.registry = createToolRegistry(context);
  }

  getDefinitions() {
    return this.registry.getDefinitions().filter((definition) =>
      this.isAllowed(definition.function.name),
    );
  }

  getToolNames(): string[] {
    return this.getDefinitions().map((definition) => definition.function.name);
  }

  async execute(name: string, input: Record<string, unknown>): Promise<ToolExecutionEnvelope> {
    const allowed = this.isAllowed(name);
    if (!allowed) {
      const artifact: ToolResultArtifact = {
        status: 'error',
        summary: `Tool "${name}" blocked by policy`,
        evidence: [],
      };
      return {
        result: { success: false, error: artifact.summary },
        artifact,
      };
    }

    const result = await this.registry.execute(name, input);
    return {
      result,
      artifact: toArtifact(name, result),
    };
  }

  private isAllowed(toolName: string): boolean {
    const capabilities = this.getToolCapabilities(toolName);
    return this.policies.every((policy) =>
      policy.allows(toolName, this.context)
      && capabilities.every((capability) => policy.allowsCapability?.(capability, this.context, toolName) ?? true),
    );
  }

  private getToolCapabilities(toolName: string): ToolCapability[] {
    const mapped = this.context.toolCapabilitiesByName?.get(toolName);
    return mapped ?? DEFAULT_TOOL_CAPABILITIES[toolName] ?? [];
  }
}
