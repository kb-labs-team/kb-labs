import type { PluginContextDescriptor } from '@kb-labs/plugin-contracts';

/** Execution payload carried by the shared @kb-labs/core-ipc stdio protocol. */
export interface ExecuteMessage {
  requestId: string;
  descriptor: PluginContextDescriptor;
  handlerPath: string;
  input: unknown;
  cwd: string;
  strictFilesystemPermissions: boolean;
  /** Host-only root for runtime module resolution; excluded from plugin env. */
  platformRoot?: string;
  outdir?: string;
}
