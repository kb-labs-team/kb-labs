import type { PluginContextDescriptor } from '@kb-labs/plugin-contracts';

/** Execution payload carried by the shared @kb-labs/core-ipc stdio protocol. */
export interface ExecuteMessage {
  requestId: string;
  descriptor: PluginContextDescriptor;
  handlerPath: string;
  /** Trusted host metadata; kept out of descriptor, plugin input, and plugin environment. */
  platformRoot?: string;
  input: unknown;
  cwd: string;
  strictFilesystemPermissions: boolean;
  outdir?: string;
}
