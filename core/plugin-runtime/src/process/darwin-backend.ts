import type { ProcessBackendCapabilities } from '@kb-labs/core-platform/adapters';
import type { GovernedProcessRequest } from '@kb-labs/core-platform/adapters';
import { NodeProcessBackend } from './node-backend.js';

export class DarwinProcessBackend extends NodeProcessBackend {
  protected override configureProcess(_pid: number, _request: GovernedProcessRequest): () => void {
    return () => {};
  }

  capabilities(): ProcessBackendCapabilities {
    return { platform: 'darwin', processGroups: true, hardMemoryLimit: false, hardCpuLimit: false, processTreeAccounting: false, maxProcesses: false };
  }
}
