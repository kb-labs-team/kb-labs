/**
 * @module @kb-labs/core-ipc/proxy
 * IPC proxy for IConfig adapter.
 *
 * This proxy forwards all config operations to the parent process via IPC.
 * The parent process owns the real ConfigAdapter instance.
 *
 * Benefits:
 * - Single source of truth for config (loaded once in parent)
 * - No need to reload kb.config.json in child processes
 * - Automatic config updates propagate to all workers
 *
 * @example
 * ```typescript
 * import { ConfigProxy } from '@kb-labs/core-ipc';
 *
 * // In child process (sandbox worker)
 * const transport = createIPCTransport();
 * const config = new ConfigProxy(transport);
 *
 * // Use like normal IConfig
 * const mindConfig = await config.getConfig('mind');
 * ```
 */

import type { IConfig } from '@kb-labs/core-platform';
import type { ITransport } from '../transport/transport';
import { RemoteAdapter } from './remote-adapter';
import type { ConfigIPCOperation } from '../ipc/adapter-contract.js';

/**
 * IPC proxy for IConfig adapter.
 *
 * All method calls are forwarded to the parent process via IPC.
 * The parent process executes the call on the real ConfigAdapter
 * and returns the result.
 *
 * From the caller's perspective, this behaves identically to a
 * local config adapter - the IPC layer is completely transparent.
 */
export class ConfigProxy extends RemoteAdapter<IConfig, ConfigIPCOperation> implements IConfig {
  /**
   * Create a config proxy.
   *
   * @param transport - IPC transport to communicate with parent
   */
  constructor(transport: ITransport) {
    super('config', transport);
  }

  /**
   * Get product-specific configuration.
   *
   * @param productId - Product identifier (e.g., 'mind', 'workflow', 'plugins')
   * @param profileId - Profile identifier (defaults to 'default' or KB_PROFILE env var)
   * @returns Promise resolving to product-specific config or undefined
   *
   * @example
   * ```typescript
   * const mindConfig = await config.getConfig('mind');
   * if (mindConfig?.scopes) {
   *   // Use scopes
   * }
   * ```
   */

  async getConfig(productId: string, profileId?: string): Promise<any> {
    return this.callRemote('getConfig', [productId, profileId]);
  }

  /**
   * Get raw kb.config.json data.
   *
   * @returns Promise resolving to raw config object or undefined
   *
   * @example
   * ```typescript
   * const rawConfig = await config.getRawConfig();
   * if (rawConfig) {
   *   const allProfiles = rawConfig.profiles;
   * }
   * ```
   */

  async getRawConfig(): Promise<any> {
    return this.callRemote('getRawConfig', []);
  }
}

export function createConfigProxy(transport: ITransport): ConfigProxy {
  return new ConfigProxy(transport);
}
