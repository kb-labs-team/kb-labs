import type { DiscoveryObservation } from '@kb-labs/plugin-contracts';
import { DiscoveryManager } from './discovery-manager.js';
import { filesystemObservationsEqual, hashDiscoveryFingerprint, replayFilesystemObservationSet } from './recording-filesystem.js';

export type DiscoveryObservationFingerprinter = (roots: readonly string[]) => Promise<string>;

/** Replays the persisted discovery observations using the discovery filesystem owner. */
export async function isDiscoverySnapshotStale(
  observations: readonly DiscoveryObservation[],
  fingerprint: string,
  requestIdentity: string,
): Promise<boolean> {
  const currentObservations = await replayFilesystemObservationSet(observations);
  return !filesystemObservationsEqual(currentObservations, observations)
    || hashDiscoveryFingerprint(requestIdentity, currentObservations) !== fingerprint;
}

/** Use the discovery pipeline itself when a consumer needs a current plugin-set digest. */
export function createDiscoveryObservationFingerprinter(): DiscoveryObservationFingerprinter {
  return async (roots) => {
    const [platformRoot, projectRoot] = roots;
    const discovery = new DiscoveryManager({ root: projectRoot ?? platformRoot, platformRoot });
    return (await discovery.discover()).fingerprint;
  };
}
