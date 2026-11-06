/**
 * Agent configuration types for kb.config.json
 */
import type { AgentSmartTieringConfig, AgentTokenBudgetConfig } from './types.js';

/**
 * Storage configuration for file history snapshots
 */
export interface FileHistoryStorageConfig {
  /** Base path for session storage (default: .kb/agents/sessions) */
  basePath?: string;
  /** Maximum number of sessions to keep (default: 30) */
  maxSessions?: number;
  /** Maximum age of sessions in days (default: 30) */
  maxAgeDays?: number;
  /** Maximum total storage size in MB (default: 500) */
  maxTotalSizeMb?: number;
  /** Enable compression for old snapshots (default: true) */
  compressOldSnapshots?: boolean;
}

/**
 * Escalation level configuration
 */
export interface EscalationLevelConfig {
  /** Enable this escalation level */
  enabled: boolean;
  /** Confidence threshold for this level (0-1) */
  confidenceThreshold: number;
  /** Maximum duration in milliseconds */
  maxDurationMs: number;
}

/**
 * Human escalation configuration
 */
export interface HumanEscalationConfig {
  /** Enable human escalation */
  enabled: boolean;
  /** Auto-escalate to human after this many milliseconds */
  autoEscalateAfterMs?: number;
}

/**
 * Escalation policy for adaptive conflict resolution
 */
export interface EscalationPolicy {
  /** Level 1: Auto-resolve (disjoint changes, 60%, <10ms) */
  level1AutoResolve: EscalationLevelConfig;
  /** Level 2: LLM-merge (overlapping changes, 30%, 2-5s) */
  level2LLMMerge: EscalationLevelConfig;
  /** Level 3: Agent coordination (conflicting intent, 8%, 10-30s) */
  level3AgentCoordination: EscalationLevelConfig;
  /** Level 4: Human escalation (unresolvable, 2%) */
  level4HumanEscalation: HumanEscalationConfig;
}

/**
 * Conflict resolution configuration
 */
export interface ConflictResolutionConfig {
  /** Default strategy: 'adaptive' | 'skip-conflicts' | 'force-overwrite' */
  defaultStrategy: 'adaptive' | 'skip-conflicts' | 'force-overwrite';
  /** Escalation policy for adaptive resolution */
  escalationPolicy: EscalationPolicy;
}

/**
 * File history configuration
 */
export interface FileHistoryConfig {
  /** Enable file history tracking */
  enabled: boolean;
  /** Storage configuration */
  storage: FileHistoryStorageConfig;
  /** Conflict resolution configuration */
  conflictResolution: ConflictResolutionConfig;
}

/**
 * Agents plugin configuration
 */
export interface AgentsPluginConfig {
  /** Enable agents plugin */
  enabled: boolean;
  /** Adaptive helper-node elevation policy (small -> medium on risk) */
  smartTiering?: AgentSmartTieringConfig;
  /** Token budget policy for long-running tasks */
  tokenBudget?: AgentTokenBudgetConfig;
  /** File history tracking configuration */
  fileHistory: FileHistoryConfig;
}

/**
 * Default configuration values
 */
export const DEFAULT_FILE_HISTORY_CONFIG: Required<FileHistoryConfig> = {
  enabled: true,
  storage: {
    basePath: '.kb/agents/sessions',
    maxSessions: 30,
    maxAgeDays: 30,
    maxTotalSizeMb: 500,
    compressOldSnapshots: true,
  },
  conflictResolution: {
    defaultStrategy: 'adaptive',
    escalationPolicy: {
      level1AutoResolve: {
        enabled: true,
        confidenceThreshold: 1.0,
        maxDurationMs: 10,
      },
      level2LLMMerge: {
        enabled: true,
        confidenceThreshold: 0.8,
        maxDurationMs: 5000,
      },
      level3AgentCoordination: {
        enabled: true,
        confidenceThreshold: 0.6,
        maxDurationMs: 30000,
      },
      level4HumanEscalation: {
        enabled: true,
        autoEscalateAfterMs: 60000,
      },
    },
  },
};

export const DEFAULT_AGENT_TOKEN_BUDGET_CONFIG: Required<
  Omit<AgentTokenBudgetConfig, 'maxTokens'>
> = {
  enabled: false,
  softLimitRatio: 0.7,
  hardLimitRatio: 1.0,
  hardStop: false,
  forceSynthesisOnHardLimit: true,
  restrictBroadExplorationAtSoftLimit: true,
  allowIterationBudgetExtension: true,
  spec: {
    enabled: true,
    multiplier: 4.0,
    floorTokens: 100_000,
    ceilingTokens: 250_000,
    synthesisReserveRatio: 0.2,
    partialOnFailure: true,
  },
};
