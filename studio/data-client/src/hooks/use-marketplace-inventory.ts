import { useQuery } from '@tanstack/react-query';
import type { MarketplaceInventoryDataSource } from '../sources/marketplace-inventory-source';

export function usePlatformAdapters(source: MarketplaceInventoryDataSource) {
  return useQuery({
    queryKey: ['marketplace', 'inventory', 'platform', 'adapters'],
    queryFn: () => source.listPlatformAdapters(),
    staleTime: 5_000,
  });
}
