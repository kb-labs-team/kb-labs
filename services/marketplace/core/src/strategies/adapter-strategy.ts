/**
 * @module @kb-labs/marketplace-core/strategies/adapter-strategy
 * Strategy for adapters — detects AdapterManifest, validates dependencies.
 */

import type { EntityKind } from '@kb-labs/plugin-contracts';
import { adapterManifestProvidesSlot, loadAdapterManifest as loadManifest } from '@kb-labs/core-platform';
import type { DetailsFor, ILogger } from '@kb-labs/core-platform';
import type {
  EntityKindStrategy,
  MarketplaceServiceAPI,
  ScopeContext,
} from '@kb-labs/marketplace-contracts';
import * as path from 'node:path';

export class AdapterManifestLoadError extends Error {
  readonly code: 'KB_ADAPTER_MANIFEST_LOAD' = 'KB_ADAPTER_MANIFEST_LOAD';
  readonly hint = 'Correct the adapter manifest, rebuild the adapter package, then run `kb marketplace plugins doctor --scope platform` to verify it.';
  readonly details: DetailsFor<'KB_ADAPTER_MANIFEST_LOAD'> = {};
  readonly metadata: { packageRoot: string; reason: string };

  constructor(packageRoot: string, reason: string) {
    super('The adapter manifest could not be loaded.');
    this.name = 'AdapterManifestLoadError';
    this.metadata = { packageRoot, reason };
  }
}

export class AdapterStrategy implements EntityKindStrategy {
  kind: EntityKind = 'adapter';

  constructor(
    private readonly logger: ILogger,
    private readonly platformRoot: string,
  ) {}

  async detectKind(packageRoot: string): Promise<EntityKind | null> {
    const result = await loadManifest({ packageRoot });
    if (result.kind === 'failed') {throw new AdapterManifestLoadError(packageRoot, result.reason);}
    return result.kind === 'adapter' ? 'adapter' : null;
  }

  async extractProvides(_packageRoot: string): Promise<EntityKind[]> {
    return ['adapter'];
  }

  async afterInstall(
    packageId: string,
    packageRoot: string,
    service: MarketplaceServiceAPI,
    ctx: ScopeContext,
  ): Promise<void> {
    const result = await loadManifest({ packageRoot });
    if (result.kind === 'failed') {throw new AdapterManifestLoadError(packageRoot, result.reason);}
    if (result.kind !== 'adapter' || !result.manifest.requires?.adapters?.length) {return;}

    // Adapters only live in platform scope (guarded in MarketplaceService),
    // so we query the same scope we were invoked with.
    const installed = await service.list(ctx, { kind: 'adapter' });
    const installedManifests = await Promise.all(installed.map(async (entry) => {
      if (!entry.resolvedPath) {return null;}
      return loadManifest({ packageRoot: path.resolve(this.platformRoot, entry.resolvedPath) });
    }));

    for (const dep of result.manifest.requires.adapters) {
      const depId = typeof dep === 'string' ? dep : dep.id;
      const found = installedManifests.some((candidate) =>
        candidate?.kind === 'adapter' && adapterManifestProvidesSlot(candidate.manifest, depId));

      if (!found) {
        this.logger.warn(
          `Adapter "${packageId}" requires platform slot "${depId}" but no installed adapter manifest provides it.`,
          { packageId, requiredSlot: depId, nextCommand: `kb marketplace plugins add <adapter-package-that-provides-${depId}>` },
        );
      }
    }
  }

  async beforeUninstall(
    packageId: string,
    service: MarketplaceServiceAPI,
    ctx: ScopeContext,
  ): Promise<void> {
    const installed = await service.list(ctx, { kind: 'adapter' });
    if (installed.length > 1) {
      this.logger.warn(`Removing adapter "${packageId}" — verify no other adapters depend on it`, { packageId });
    }
  }
}
