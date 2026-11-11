/**
 * Plugin Configuration Contract
 *
 * Defines the shape of plugin configuration stored in kb.config.json
 * under plugins.commit section.
 *
 * This type is the single source of truth for:
 * - defineSetup (setup handler knows what config to create)
 * - defineCommand (commands can access typed config)
 */

/**
 * LLM configuration for commit generation
 */
export interface LLMConfig {
  /** Whether to use LLM for commit generation (default: true) */
  enabled: boolean;
  /** Temperature for LLM responses (0-1, default: 0.3) */
  temperature: number;
  /** Maximum tokens for LLM response (default: 2000) */
  maxTokens: number;
}

/**
 * Storage configuration
 */
export interface StorageConfig {
  /** Directory for commit plugin data (default: .kb/commit) */
  directory: string;
}

/**
 * Git configuration
 */
export interface GitConfig {
  /** Protected branches that require confirmation (default: ['main', 'master']) */
  protectedBranches: string[];
  /** Whether to auto-stage all changes before commit (default: false) */
  autoStage: boolean;
}

/**
 * A single commit scope definition
 */
export interface CommitScope {
  /** Scope identifier — used as value in selector and in API requests */
  id: string;
  /** Display label shown in Studio UI */
  label: string;
  /**
   * Relative path from workspace root to the target git repository.
   * Use "." for the workspace root itself.
   * @example "."
   * @example "public/kb-labs"
   * @example "plugins/kb-labs-mind"
   */
  path: string;
  /** Optional description shown in Studio selector */
  description?: string;
}

/**
 * Scope configuration
 */
export interface ScopeConfig {
  /** Default scope id to pre-select in Studio and use when not specified via CLI */
  default?: string;
  /**
   * Explicit list of available scopes.
   * If not provided, falls back to a single "root" scope (workspace root).
   *
   * @example
   * ```json
   * "scopes": [
   *   { "id": "root", "label": "workspace root", "path": "." },
   *   { "id": "public/kb-labs", "label": "kb-labs (public)", "path": "public/kb-labs" }
   * ]
   * ```
   */
  scopes?: CommitScope[];
}

/**
 * Plugin configuration stored in kb.config.json
 *
 * @example
 * ```json
 * {
 *   "plugins": {
 *     "commit": {
 *       "enabled": true,
 *       "llm": {
 *         "enabled": true,
 *         "temperature": 0.3,
 *         "maxTokens": 2000
 *       },
 *       "storage": {
 *         "directory": ".kb/commit"
 *       },
 *       "git": {
 *         "protectedBranches": ["main", "master"],
 *         "autoStage": false
 *       },
 *       "scope": {
 *         "default": "kb-labs-commit-plugin"
 *       }
 *     }
 *   }
 * }
 * ```
 */
export interface CommitPluginConfig {
  /** Whether the plugin is enabled */
  enabled: boolean;
  /** LLM configuration */
  llm: LLMConfig;
  /** Storage configuration */
  storage: StorageConfig;
  /** Git configuration */
  git: GitConfig;
  /** Scope configuration */
  scope?: ScopeConfig;
}

/**
 * Environment variables supported by commit plugin
 * Must be declared in manifest.permissions.env.allow
 */
export const COMMIT_ENV_VARS = [
  "KB_COMMIT_LLM_ENABLED",
  "KB_COMMIT_LLM_TEMPERATURE",
  "KB_COMMIT_LLM_MAX_TOKENS",
  "KB_COMMIT_STORAGE_DIR",
  "KB_COMMIT_AUTO_STAGE",
] as const;

export type CommitEnvVar = (typeof COMMIT_ENV_VARS)[number];

/**
 * Default plugin configuration values
 */
export const defaultCommitConfig: CommitPluginConfig = {
  enabled: true,
  llm: {
    enabled: true,
    temperature: 0.3,
    maxTokens: 2000,
  },
  storage: {
    directory: ".kb/commit",
  },
  git: {
    protectedBranches: ["main", "master"],
    autoStage: false,
  },
  scope: {
    default: 'root',
    scopes: [{ id: 'root', label: 'root', path: '.' }],
  },
};

/**
 * Resolve config with env variable overrides
 *
 * @param fileConfig - Config from kb.config.json (via useConfig)
 * @param env - Environment variables (from commitEnv.parse(runtime))
 */
export function resolveCommitConfig(
  fileConfig: Partial<CommitPluginConfig> = {},
  env: Partial<{
    KB_COMMIT_LLM_ENABLED: boolean;
    KB_COMMIT_LLM_TEMPERATURE: number;
    KB_COMMIT_LLM_MAX_TOKENS: number;
    KB_COMMIT_STORAGE_DIR: string;
    KB_COMMIT_AUTO_STAGE: boolean;
  }> = {},
): CommitPluginConfig {
  const config: CommitPluginConfig = {
    enabled: fileConfig.enabled ?? defaultCommitConfig.enabled,
    llm: {
      enabled:
        env.KB_COMMIT_LLM_ENABLED ??
        fileConfig.llm?.enabled ??
        defaultCommitConfig.llm.enabled,
      temperature:
        env.KB_COMMIT_LLM_TEMPERATURE ??
        fileConfig.llm?.temperature ??
        defaultCommitConfig.llm.temperature,
      maxTokens:
        env.KB_COMMIT_LLM_MAX_TOKENS ??
        fileConfig.llm?.maxTokens ??
        defaultCommitConfig.llm.maxTokens,
    },
    storage: {
      directory:
        env.KB_COMMIT_STORAGE_DIR ??
        fileConfig.storage?.directory ??
        defaultCommitConfig.storage.directory,
    },
    git: {
      protectedBranches:
        fileConfig.git?.protectedBranches ??
        defaultCommitConfig.git.protectedBranches,
      autoStage:
        env.KB_COMMIT_AUTO_STAGE ??
        fileConfig.git?.autoStage ??
        defaultCommitConfig.git.autoStage,
    },
    scope: {
      default: fileConfig.scope?.default ?? defaultCommitConfig.scope?.default,
      scopes: fileConfig.scope?.scopes ?? defaultCommitConfig.scope?.scopes,
    },
  };

  return config;
}
