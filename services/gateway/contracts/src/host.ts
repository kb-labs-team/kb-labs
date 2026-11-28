import { z } from 'zod';
import { WorkspaceInfoSchema, PluginInfoSchema } from './protocol.js';

export const HostCapabilitySchema = z.enum(['filesystem', 'git', 'editor-context', 'execution']);

export const HostTypeSchema = z.enum(['local', 'cloud']);

export const HostRegistrationSchema = z.object({
  name: z.string(),
  namespaceId: z.string(),
  capabilities: z.array(HostCapabilitySchema),
  workspacePaths: z.array(z.string()),
  hostType: HostTypeSchema.optional(),
});

export const HostStatusSchema = z.enum(['online', 'offline', 'degraded', 'reconnecting']);

export const HostDescriptorSchema = z.object({
  hostId: z.string(),
  name: z.string(),
  namespaceId: z.string(),
  capabilities: z.array(HostCapabilitySchema),
  status: HostStatusSchema,
  lastSeen: z.number(),
  connections: z.array(z.string()),
  // Workspace Agent metadata (populated from hello message)
  hostType: HostTypeSchema.optional(),
  workspaces: z.array(WorkspaceInfoSchema).optional(),
  plugins: z.array(PluginInfoSchema).optional(),
  // Persistence metadata
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

export const HostListResponseSchema = z.object({ hosts: z.array(HostDescriptorSchema) });

export const HostRegisterResponseSchema = z.object({
  hostId: z.string(),
  machineToken: z.string(),
  status: HostStatusSchema,
});

export type HostStatus = z.infer<typeof HostStatusSchema>;
export type HostCapability = z.infer<typeof HostCapabilitySchema>;
export type HostType = z.infer<typeof HostTypeSchema>;
export type HostRegistration = z.infer<typeof HostRegistrationSchema>;
export type HostDescriptor = z.infer<typeof HostDescriptorSchema>;
export type HostRegisterResponse = z.infer<typeof HostRegisterResponseSchema>;

/**
 * Durable host storage abstraction.
 *
 * Implementations persist host descriptors and tokens across restarts.
 * The registry uses this as the "cold" layer while ICache serves as "hot" layer.
 */
export interface IHostStore {
  /** Persist or update a host descriptor. */
  save(descriptor: HostDescriptor): Promise<void>;

  /** Retrieve a host by id + namespace. */
  get(hostId: string, namespaceId: string): Promise<HostDescriptor | null>;

  /** List all hosts in a namespace. */
  list(namespaceId: string): Promise<HostDescriptor[]>;

  /** List all hosts across all namespaces. */
  listAll(): Promise<HostDescriptor[]>;

  /** Remove a host. Returns true if it existed. */
  delete(hostId: string, namespaceId: string): Promise<boolean>;

  /** Persist a machine token → host mapping. */
  saveToken(token: string, hostId: string, namespaceId: string): Promise<void>;

  /** Resolve a machine token to its host. */
  resolveToken(token: string): Promise<{ hostId: string; namespaceId: string } | null>;

  /** Remove a machine token. */
  deleteToken(token: string): Promise<void>;
}
