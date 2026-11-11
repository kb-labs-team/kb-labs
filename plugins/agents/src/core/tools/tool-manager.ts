/**
 * ToolManager — single enforcement layer for tool registration and execution.
 *
 * Responsibilities:
 * 1. Register ToolPacks with namespace assignment and conflict resolution
 * 2. Resolve tool names (short or qualified) to the correct packed tool
 * 3. Enforce permissions (allowedPaths, deniedCommands, networkAllowed)
 * 4. Audit trail logging (when auditTrail: true)
 * 5. Delegate execution to the packed tool
 *
 * Tools and packs do NOT check permissions themselves — ToolManager does.
 */

import type {
  ToolPack,
  PackedTool,
  ResolvedTool,
  ToolFilter,
  ToolDefinition,
  ToolResult,
} from '../../contracts/index.js';

export interface ToolManagerOptions {
  /** Called before each tool execution when pack has auditTrail: true */
  onAudit?: (toolName: string, packId: string, input: Record<string, unknown>) => void;
  /** Called on registration errors (for logging) */
  onError?: (message: string) => void;
}

export class ToolManager {
  private readonly packs = new Map<string, ToolPack>();
  private readonly resolvedTools = new Map<string, ResolvedTool>();
  private readonly options: ToolManagerOptions;

  constructor(options: ToolManagerOptions = {}) {
    this.options = options;
  }

  // ── Registration ───────────────────────────────────────────────

  /**
   * Register a ToolPack. Handles namespace assignment and conflict resolution.
   * @throws If conflictPolicy is 'error' and a name collision occurs
   */
  register(pack: ToolPack): void {
    if (pack.enabled && !pack.enabled()) {
      return; // Pack is disabled, skip
    }

    if (this.packs.has(pack.id)) {
      throw new Error(`ToolPack "${pack.id}" is already registered`);
    }

    this.packs.set(pack.id, pack);

    for (const tool of pack.tools) {
      const shortName = tool.definition.function.name;
      const qualifiedName = `${pack.namespace}.${shortName}`;

      const existing = this.resolvedTools.get(shortName);

      if (existing) {
        this.resolveConflict(pack, tool, shortName, qualifiedName, existing);
      } else {
        // No conflict — register with short name
        this.resolvedTools.set(shortName, this.createResolved(pack, tool, shortName));
      }
    }
  }

  private resolveConflict(
    pack: ToolPack,
    tool: PackedTool,
    shortName: string,
    qualifiedName: string,
    existing: ResolvedTool,
  ): void {
    const existingPack = this.packs.get(existing.packId)!;

    // Both packs must agree on conflict policy (use the stricter one)
    const effectivePolicy =
      pack.conflictPolicy === 'error' || existingPack.conflictPolicy === 'error'
        ? 'error'
        : pack.conflictPolicy === 'namespace-prefix' || existingPack.conflictPolicy === 'namespace-prefix'
          ? 'namespace-prefix'
          : 'override';

    switch (effectivePolicy) {
      case 'error':
        throw new Error(
          `Tool name conflict: "${shortName}" exists in pack "${existing.packId}" ` +
          `and pack "${pack.id}". Both use conflictPolicy 'error'.`,
        );

      case 'namespace-prefix': {
        // Move existing to qualified name if not already
        if (existing.qualifiedName === shortName) {
          this.resolvedTools.delete(shortName);
          const existingQualified = `${existing.namespace}.${shortName}`;
          this.resolvedTools.set(
            existingQualified,
            this.createResolved(existingPack, this.findPackedTool(existingPack, shortName)!, existingQualified),
          );
        }
        // Register new with qualified name
        this.resolvedTools.set(qualifiedName, this.createResolved(pack, tool, qualifiedName));
        break;
      }

      case 'override': {
        // Higher priority wins
        const existingPackPriority = this.packs.get(existing.packId)?.priority ?? 0;
        if (pack.priority > existingPackPriority) {
          this.resolvedTools.set(shortName, this.createResolved(pack, tool, shortName));
        }
        // else: existing stays
        break;
      }
    }
  }

  private findPackedTool(pack: ToolPack, shortName: string): PackedTool | undefined {
    return pack.tools.find((t) => t.definition.function.name === shortName);
  }

  private createResolved(pack: ToolPack, tool: PackedTool, qualifiedName: string): ResolvedTool {
    const shortName = tool.definition.function.name;

    // Create a definition with the qualified name
    const definition: ToolDefinition = qualifiedName === shortName
      ? tool.definition
      : {
          ...tool.definition,
          function: {
            ...tool.definition.function,
            name: qualifiedName,
          },
        };

    return {
      qualifiedName,
      shortName,
      packId: pack.id,
      namespace: pack.namespace,
      definition,
      readOnly: tool.readOnly ?? false,
      concurrencySafe: tool.concurrencySafe ?? false,
      capability: tool.capability,
      execute: (input) => tool.execute(input),
    };
  }

  // ── Queries ────────────────────────────────────────────────────

  /**
   * Get all tool definitions matching the filter. Used to build the LLM tool list.
   */
  getDefinitions(filter?: ToolFilter): ToolDefinition[] {
    return this.getTools(filter).map((t) => t.definition);
  }

  /**
   * Get resolved tools matching the filter.
   */
  getTools(filter?: ToolFilter): ResolvedTool[] {
    let tools = [...this.resolvedTools.values()];

    if (filter?.readOnly) {
      tools = tools.filter((t) => t.readOnly);
    }
    if (filter?.capability) {
      tools = tools.filter((t) => t.capability === filter.capability);
    }
    if (filter?.namespace) {
      tools = tools.filter((t) => t.namespace === filter.namespace);
    }

    return tools;
  }

  /**
   * Get a single tool by name (short or qualified).
   */
  getTool(name: string): ResolvedTool | undefined {
    return this.resolvedTools.get(name);
  }

  /**
   * Get sorted list of tool names.
   */
  getToolNames(): string[] {
    return [...this.resolvedTools.keys()].sort();
  }

  /**
   * Check if a tool exists.
   */
  hasTool(name: string): boolean {
    return this.resolvedTools.has(name);
  }

  /**
   * Get all registered pack IDs.
   */
  getPackIds(): string[] {
    return [...this.packs.keys()];
  }

  // ── Execution ──────────────────────────────────────────────────

  /**
   * Execute a tool by name. This is the SINGLE enforcement layer:
   * 1. Resolve name → find tool
   * 2. Permission check (allowedPaths, deniedCommands, networkAllowed)
   * 3. Audit trail (if enabled)
   * 4. Delegate to pack executor
   */
  async execute(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.resolvedTools.get(name);
    if (!tool) {
      return {
        success: false,
        error: `Tool "${name}" not found. Available: ${this.getToolNames().join(', ')}`,
      };
    }

    const pack = this.packs.get(tool.packId);
    if (!pack) {
      return {
        success: false,
        error: `Pack "${tool.packId}" not found for tool "${name}"`,
      };
    }

    // Permission check
    const permissionError = this.checkPermissions(pack, name, input);
    if (permissionError) {
      return permissionError;
    }

    // Audit trail
    if (pack.permissions?.auditTrail) {
      this.options.onAudit?.(name, pack.id, input);
    }

    // Delegate
    return tool.execute(input);
  }

  private checkPermissions(
    pack: ToolPack,
    toolName: string,
    input: Record<string, unknown>,
  ): ToolResult | null {
    const perms = pack.permissions;
    if (!perms) {return null;}

    // Check denied commands (for shell tools)
    if (perms.deniedCommands && perms.deniedCommands.length > 0) {
      const command = typeof input.command === 'string' ? input.command : '';
      for (const denied of perms.deniedCommands) {
        if (command.startsWith(denied)) {
          return {
            success: false,
            error: `Permission denied: command "${denied}" is blocked for pack "${pack.id}"`,
            errorDetails: {
              code: 'PERMISSION_DENIED',
              message: `Command "${denied}" is in the deny list`,
              retryable: false,
            },
          };
        }
      }
    }

    // Check allowed paths (for filesystem tools)
    if (perms.allowedPaths && perms.allowedPaths.length > 0) {
      const path = typeof input.path === 'string' ? input.path : undefined;
      if (path) {
        const allowed = perms.allowedPaths.some((pattern) =>
          path.startsWith(pattern) || pattern === '*',
        );
        if (!allowed) {
          return {
            success: false,
            error: `Permission denied: path "${path}" is not in allowed paths for pack "${pack.id}"`,
            errorDetails: {
              code: 'PATH_DENIED',
              message: `Path "${path}" outside allowed paths`,
              retryable: false,
            },
          };
        }
      }
    }

    // Check network access
    if (perms.networkAllowed === false) {
      const isNetworkTool = toolName.includes('http') || toolName.includes('fetch') || toolName.includes('request');
      if (isNetworkTool) {
        return {
          success: false,
          error: `Permission denied: network access is disabled for pack "${pack.id}"`,
          errorDetails: {
            code: 'NETWORK_DENIED',
            message: 'Network access is not allowed',
            retryable: false,
          },
        };
      }
    }

    return null;
  }

  // ── Filtering ─────────────────────────────────────────────────

  /**
   * Remove all resolved tools whose short name is NOT in the allowlist.
   * Used by sub-agents with preset-based tool restrictions.
   */
  applyAllowlist(allowedTools: string[]): void {
    const allowed = new Set(allowedTools);
    for (const [name, tool] of this.resolvedTools) {
      if (!allowed.has(tool.shortName)) {
        this.resolvedTools.delete(name);
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /**
   * Initialize all registered packs.
   */
  async initializeAll(): Promise<void> {
    for (const pack of this.packs.values()) {
      if (pack.initialize) {
        await pack.initialize();
      }
    }
  }

  /**
   * Dispose all registered packs.
   */
  async disposeAll(): Promise<void> {
    for (const pack of this.packs.values()) {
      if (pack.dispose) {
        await pack.dispose();
      }
    }
  }
}
