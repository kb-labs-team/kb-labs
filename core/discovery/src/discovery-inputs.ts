import type { DiscoveryObservation } from '@kb-labs/plugin-contracts';
import { DiscoveryManager } from './discovery-manager.js';
import { replayFilesystemObservations } from './recording-filesystem.js';

export type DiscoveryObservationFingerprinter = (roots: readonly string[]) => Promise<string>;

/** Replays the persisted discovery observations using the discovery filesystem owner. */
export async function isDiscoverySnapshotStale(
  observations: readonly DiscoveryObservation[],
  fingerprint: string,
): Promise<boolean> {
  return await replayFilesystemObservations(observations) !== fingerprint;
}

/** Use the discovery pipeline itself when a consumer needs a current plugin-set digest. */
export function createDiscoveryObservationFingerprinter(): DiscoveryObservationFingerprinter {
  return async (roots) => {
    const [platformRoot, projectRoot] = roots;
    const discovery = new DiscoveryManager({ root: projectRoot ?? platformRoot, platformRoot });
    return (await discovery.discover()).fingerprint;
  };
}
