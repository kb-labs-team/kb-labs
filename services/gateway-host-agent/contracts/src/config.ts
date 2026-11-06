import { z } from 'zod';

/** Token pair returned by Gateway /auth/token and /auth/refresh */
export const TokenPairSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().positive(),
  tokenType: z.literal('Bearer'),
});

/** Execution configuration for Workspace Agent */
export const ExecutionConfigSchema = z.object({
  /** Execution mode: in-process (fast, trust) or subprocess (sandboxed) */
  mode: z.enum(['in-process', 'subprocess']).default('in-process'),
  /** Overall execution timeout in ms */
  timeoutMs: z.number().positive().default(120_000),
  /** Plugin allowlist. Empty/undefined = all plugins allowed. */
  allowedPlugins: z.array(z.string()).optional(),
});

/** Workspace entry — describes a project directory managed by this agent */
export const WorkspaceEntrySchema = z.object({
  /** Logical workspace ID */
  workspaceId: z.string(),
  /** Absolute path to project root */
  path: z.string(),
  /** Hash(origin URL + root commit) for repo identity */
  repoFingerprint: z.string().optional(),
});

/**
 * ~/.kb/agent.json — persisted on the developer's machine after `kb workspace register`
 */
export const AgentConfigSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  hostId: z.string(),
  gatewayUrl: z.string().url().refine(
    (url) => url.startsWith('https://') || url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1'),
    { message: 'gatewayUrl must use HTTPS (HTTP only allowed for localhost in dev)' },
  ),
  /** X25519 private key, base64url — never leaves the machine */
  privateKey: z.string().optional(),
  /** X25519 public key, base64url — sent to Gateway on hello */
  publicKey: z.string().optional(),
  namespaceId: z.string().default('default'),
  /** Host type: local (developer laptop) or cloud (provisioned container) */
  hostType: z.enum(['local', 'cloud']).default('local'),
  /**
   * Explicit list of workspace paths the agent is allowed to access.
   * Principle of least privilege: no access outside these paths.
   */
  workspacePaths: z.array(z.string()).min(1),
  /** Structured workspace entries (optional, enriches workspacePaths) */
  workspaces: z.array(WorkspaceEntrySchema).optional(),
  /** Execution configuration for plugin execution capability */
  execution: ExecutionConfigSchema.default({}),
});

export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
