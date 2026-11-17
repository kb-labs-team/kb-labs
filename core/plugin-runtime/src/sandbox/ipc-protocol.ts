import type { PluginContextDescriptor } from '@kb-labs/plugin-contracts';

/** Execution payload carried by the shared @kb-labs/core-ipc stdio protocol. */
export interface ExecuteMessage {
  requestId: string;
  descriptor: PluginContextDescriptor;
  handlerPath: string;
  input: unknown;
  cwd: string;
  /** Host-resolved platform root. Never exposed through plugin environment grants. */
  platformRoot?: string;
  strictFilesystemPermissions: boolean;
  outdir?: string;
}
