import type { PermissionSpec as ContractsPermissionSpec } from '@kb-labs/plugin-contracts';

/**
 * Platform service permissions
 */
export interface PlatformPermissions {
  /** LLM access */
  llm?: boolean | { models?: string[] };
  /** Vector store access */
  vectorStore?: boolean | { collections?: string[] };
  /** Cache access */
  cache?: boolean | string[]; // true = all, string[] = namespaces
  /**
   * Storage access (file/blob storage)
   *
   * **Formats:**
   * - `true` - full access (all read/write)
   * - `false` - no access
   * - `string[]` - path prefixes (both read + write)
   * - `{ paths?: string[] }` - explicit path-prefix allow-list
   *
   * **Examples:**
   * ```typescript
   * storage: true  // Full access
   * storage: ['.kb/artifacts/']  // Read + write keys under .kb/artifacts/
   * storage: { paths: ['.kb/artifacts/'] }  // Read and write only within .kb/artifacts
   * ```
   */
  storage?: boolean | string[] | { paths?: string[] };
  /**
   * Database access (SQL, Document, KV, TimeSeries)
   *
   * **Formats:**
   * - `true` - full access to all databases
   * - `false` - no access
   * - Granular per database type:
   *   - `sql?: { tables?: string[] }` - SQL table access
   *   - `document?: { collections?: string[] }` - Document collection access
   *   - `kv?: { prefixes?: string[] }` - KV key prefix access
   *   - `timeseries?: { metrics?: string[] }` - TimeSeries metric access
   *
   * **Examples:**
   * ```typescript
   * database: true  // Full access to all databases
   * database: {
   *   sql: { tables: ['incidents', 'audit_log'] },
   *   document: { collections: ['workflows'] }
   * }
   * ```
   */
  database?:
    | boolean
    | {
        sql?: boolean | { tables?: string[] };
        document?: boolean | { collections?: string[] };
        kv?: boolean | { prefixes?: string[] };
        timeseries?: boolean | { metrics?: string[] };
      };
  /** Analytics access */
  analytics?: boolean;
  /** Embeddings access */
  embeddings?: boolean;
  /** Event bus access */
  events?: boolean | { publish?: string[]; subscribe?: string[] };
  /** Notifier access */
  notifier?: {
    emit?: boolean;
    subscribe?: {
      sources: string[];
      severity?: Array<'info' | 'warn' | 'critical'>;
    };
  };
}

/**
 * Permission specification for preset building (declarative format)
 * This is the format used when defining presets and combining them.
 *
 * Design:
 * - Presets declare what plugin WANTS (allow-list only)
 * - No deny - platform enforces hardcoded security patterns
 */
export interface PermissionSpec {
  /** File system permissions */
  fs?: {
    mode?: 'read' | 'readWrite';
    allow?: string[];
  };
  /** Environment variable permissions */
  env?: {
    read?: string[];
  };
  /** Network permissions */
  network?: {
    fetch?: string[];
    /** Raw TCP connect targets. Patterns: 'imap.gmail.com:993', '*.smtp.example.com:587' */
    tcp?: { connect?: string[] };
    /** WebSocket connect targets. Patterns: 'wss://api.openai.com', 'wss://*.slack.com' */
    ws?: { connect?: string[] };
  };
  /** Platform service permissions */
  platform?: PlatformPermissions;
  /** Shell execution permissions */
  shell?: {
    allow?: string[];
    /** Maximum concurrent shell processes owned by this plugin. */
    maxConcurrent?: number;
  };
  /** Resource quotas */
  quotas?: {
    timeoutMs?: number;
    memoryMb?: number;
    cpuMs?: number;
  };
}

/**
 * Runtime permission specification — canonical output of build().
 * Alias for plugin-contracts PermissionSpec so manifests can use either import.
 */
export type RuntimePermissionSpec = ContractsPermissionSpec;

/**
 * A preset is a named permission configuration
 */
export interface PermissionPreset {
  /** Unique preset identifier */
  id: string;
  /** Human-readable description */
  description: string;
  /** The permission spec this preset provides */
  permissions: PermissionSpec;
}

/**
 * Builder for combining multiple presets
 */
export interface PresetBuilder {
  /** Add a preset to the combination */
  with(preset: PermissionPreset | PermissionSpec): PresetBuilder;
  /** Add environment variables to read */
  withEnv(vars: string[]): PresetBuilder;
  /** Add file system permissions */
  withFs(fs: PermissionSpec['fs']): PresetBuilder;
  /** Add network permissions */
  withNetwork(network: PermissionSpec['network']): PresetBuilder;
  /** Add platform service permissions */
  withPlatform(platform: PlatformPermissions): PresetBuilder;
  /** Add shell execution permissions */
  withShell(shell: PermissionSpec['shell']): PresetBuilder;
  /** Add quotas */
  withQuotas(quotas: PermissionSpec['quotas']): PresetBuilder;
  /**
   * Add storage permissions.
   *
   * @param storage - Storage permissions (true, string[], or { paths })
   * @returns Builder for chaining
   *
   * @example
   * ```typescript
   * .withStorage({ paths: ['.kb/artifacts/'] })
   * .withStorage(['.kb/data/'])  // Both read + write
   * ```
   */
  withStorage(storage: PlatformPermissions['storage']): PresetBuilder;
  /**
   * Add database permissions.
   *
   * @param database - Database permissions (true or granular per type)
   * @returns Builder for chaining
   *
   * @example
   * ```typescript
   * .withDatabase({ sql: { tables: ['incidents'] } })
   * .withDatabase(true)  // Full database access
   * ```
   */
  withDatabase(database: PlatformPermissions['database']): PresetBuilder;
  /** Build the final permission spec (converts to runtime format) */
  build(): ContractsPermissionSpec;
}
