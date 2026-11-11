/**
 * AgentRegistry — typed catalogue of agent presets.
 *
 * Each preset specifies:
 * - toolPacks: which ToolPacks the agent gets (namespaces, not concrete classes)
 * - featureFlags overrides (vs DEFAULT_FEATURE_FLAGS)
 * - systemPrompt suffix (appended after the base prompt)
 * - maxIterations default
 * - readOnly: prevents write tools being registered
 *
 * Presets ship with the platform; consumers can add custom types via register().
 *
 * Design: registry is purely a data store (no Agent instantiation here).
 * The Orchestrator reads registry to configure child agents.
 */

import type { FeatureFlags } from '../../contracts/index.js';
import { DEFAULT_FEATURE_FLAGS } from '../../contracts/index.js';

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

/**
 * Which tool packs an agent is allowed to load.
 * 'core'    — read-only file system, search, memory tools
 * 'coder'   — full FS (write, patch), shell execution
 * 'kb-labs' — kb-labs specific tools (mind-rag, workflow, etc.)
 */
export type ToolPackRef = 'core' | 'coder' | 'kb-labs' | string;

/**
 * A registered agent type definition.
 */
export interface AgentTypeDefinition {
  /** Unique identifier, used when spawning: `registry.get('researcher')` */
  readonly id: string;
  /** Human-readable label */
  readonly label: string;
  /** Brief description shown in UIs and prompts */
  readonly description: string;
  /** Tool packs this agent is allowed to use */
  readonly toolPacks: ToolPackRef[];
  /** Feature flag overrides (merged on top of DEFAULT_FEATURE_FLAGS) */
  readonly featureFlags?: Partial<FeatureFlags>;
  /** Suffix appended to the base system prompt */
  readonly systemPromptSuffix?: string;
  /** Default max iterations (can be overridden at spawn time) */
  readonly maxIterations: number;
  /** If true, write/patch/exec tools are stripped from registered packs */
  readonly readOnly: boolean;
  /** Max spawn depth: 0 = cannot spawn children */
  readonly maxDepth: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Built-in presets
// ═══════════════════════════════════════════════════════════════════════

const PRESETS: readonly AgentTypeDefinition[] = [
  {
    id: 'researcher',
    label: 'Researcher',
    description:
      'Read-only agent specialised in codebase exploration and evidence gathering. Cannot modify files.',
    toolPacks: ['core', 'kb-labs'],
    featureFlags: {
      searchSignal: true,
      taskClassifier: true,
    },
    systemPromptSuffix:
      'You are a researcher. Your goal is to gather evidence and report findings. Do NOT create or modify files.',
    maxIterations: 15,
    readOnly: true,
    maxDepth: 0,
  },
  {
    id: 'coder',
    label: 'Coder',
    description:
      'Full-access agent for code generation, refactoring, and fixes. Has write and shell access.',
    toolPacks: ['core', 'coder', 'kb-labs'],
    featureFlags: {
      todoSync: true,
      reflection: true,
    },
    systemPromptSuffix:
      'You are a coder. Your goal is to implement changes correctly and efficiently.',
    maxIterations: 20,
    readOnly: false,
    maxDepth: 1,
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    description:
      'Read-only agent for code review, analysis, and quality assessment.',
    toolPacks: ['core'],
    featureFlags: {
      searchSignal: true,
      taskClassifier: true,
      reflection: true,
    },
    systemPromptSuffix:
      'You are a code reviewer. Analyse code quality, identify bugs, and suggest improvements. Do NOT modify files.',
    maxIterations: 10,
    readOnly: true,
    maxDepth: 0,
  },
  {
    id: 'orchestrator',
    label: 'Orchestrator',
    description:
      'Meta-agent that decomposes complex tasks and delegates to specialised sub-agents.',
    toolPacks: ['core', 'kb-labs'],
    featureFlags: {
      tierEscalation: true,
      taskClassifier: true,
    },
    systemPromptSuffix:
      'You are an orchestrator. Break complex tasks into subtasks and delegate them to specialised agents.',
    maxIterations: 10,
    readOnly: true,
    maxDepth: 3,
  },
];

// ═══════════════════════════════════════════════════════════════════════
// AgentRegistry
// ═══════════════════════════════════════════════════════════════════════

export class AgentRegistry {
  private readonly definitions = new Map<string, AgentTypeDefinition>();

  constructor() {
    // Register built-in presets
    for (const preset of PRESETS) {
      this.definitions.set(preset.id, preset);
    }
  }

  /**
   * Register a custom agent type or override a preset.
   * Throws if id is empty.
   */
  register(definition: AgentTypeDefinition): void {
    if (!definition.id.trim()) {
      throw new Error('AgentTypeDefinition.id must be non-empty');
    }
    this.definitions.set(definition.id, definition);
  }

  /**
   * Get an agent type definition by id.
   * Returns undefined if not found (callers should handle missing types).
   */
  get(id: string): AgentTypeDefinition | undefined {
    return this.definitions.get(id);
  }

  /**
   * Get an agent type definition, throwing if not found.
   */
  getOrThrow(id: string): AgentTypeDefinition {
    const def = this.definitions.get(id);
    if (!def) {
      throw new Error(
        `Agent type '${id}' not found in registry. Available: ${this.listIds().join(', ')}`,
      );
    }
    return def;
  }

  /**
   * List all registered agent type ids.
   */
  listIds(): string[] {
    return Array.from(this.definitions.keys());
  }

  /**
   * List all registered agent type definitions.
   */
  list(): AgentTypeDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * Merge feature flags: DEFAULT + preset overrides.
   */
  resolveFeatureFlags(id: string): FeatureFlags {
    const def = this.get(id);
    return {
      ...DEFAULT_FEATURE_FLAGS,
      ...(def?.featureFlags ?? {}),
    };
  }

  /**
   * Check whether a definition exists.
   */
  has(id: string): boolean {
    return this.definitions.has(id);
  }
}

/**
 * Singleton registry for the process (can be replaced in tests).
 */
export const globalAgentRegistry = new AgentRegistry();
