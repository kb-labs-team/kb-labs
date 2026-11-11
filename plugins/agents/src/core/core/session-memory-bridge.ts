import { createKernelState, recordConstraint, recordCorrection } from '../../kernel/index.js';
import { SessionArtifactStore } from '../../store/index.js';
import type { KernelState } from '../../contracts/index.js';
import type { SessionMemoryBridge } from '../../tools/index.js';

async function loadOrCreateKernel(
  store: SessionArtifactStore,
  workingDir: string,
  sessionId: string,
): Promise<KernelState> {
  const existing = await store.loadKernelState(sessionId);
  if (existing) {
    return existing;
  }
  const created = createKernelState({
    sessionId,
    workingDir,
    mode: 'assistant',
    task: '',
  });
  await store.saveKernelState(sessionId, created);
  return created;
}

export function createSessionMemoryBridge(
  workingDir: string,
  sessionId?: string,
): SessionMemoryBridge | undefined {
  if (!sessionId) {
    return undefined;
  }

  const store = new SessionArtifactStore(workingDir);

  return {
    async loadKernelState(): Promise<KernelState | null> {
      return store.loadKernelState(sessionId);
    },
    async recordConstraint(content: string): Promise<KernelState> {
      const kernel = await loadOrCreateKernel(store, workingDir, sessionId);
      const updated = recordConstraint(kernel, content);
      await store.saveKernelState(sessionId, updated);
      return updated;
    },
    async recordCorrection(input: {
      content: string;
      invalidates?: string[];
      asConstraint?: boolean;
    }): Promise<KernelState> {
      const kernel = await loadOrCreateKernel(store, workingDir, sessionId);
      let updated = recordCorrection(kernel, input.content, input.invalidates);
      if (input.asConstraint) {
        updated = recordConstraint(updated, input.content);
      }
      await store.saveKernelState(sessionId, updated);
      return updated;
    },
  };
}
