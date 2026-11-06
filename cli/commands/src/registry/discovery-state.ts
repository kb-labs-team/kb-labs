import type { DetailedDiscovery } from './discover.js';
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';

let registeredDiscovery: DetailedDiscovery | undefined;
let resolvedCatalog: IEntityRegistry | undefined;

export function setResolvedCatalog(catalog: IEntityRegistry | undefined): void {
  resolvedCatalog = catalog;
}

export function getResolvedCatalog(): IEntityRegistry | undefined {
  return resolvedCatalog;
}

export function requireResolvedCatalog(): IEntityRegistry {
  if (!resolvedCatalog) throw new Error('The CLI catalog was not opened during command registration.');
  return resolvedCatalog;
}

export function setRegisteredDiscovery(discovery: DetailedDiscovery | undefined): void {
  registeredDiscovery = discovery;
}

export function getRegisteredDiscovery(): DetailedDiscovery | undefined {
  return registeredDiscovery;
}
