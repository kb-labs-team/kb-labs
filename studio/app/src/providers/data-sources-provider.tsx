import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createDataSources, type DataSources } from '@kb-labs/studio-data-client';
import { studioConfig } from '@/config/studio.config';

// Exported so tests can inject a mock DataSources value via <DataSourcesContext.Provider>.
export const DataSourcesContext = createContext<DataSources | null>(null);

export function DataSourcesProvider({ children }: { children: ReactNode }) {
  const sources = useMemo(
    () => createDataSources({
      mode: studioConfig.dataSourceMode,
      baseUrl: studioConfig.apiBaseUrl,
      token: studioConfig.gatewayToken,
    }),
    [],
  );

  return <DataSourcesContext.Provider value={sources}>{children}</DataSourcesContext.Provider>;
}

export function useDataSources() {
  const context = useContext(DataSourcesContext);
  if (!context) {
    throw new Error('useDataSources must be used within DataSourcesProvider');
  }
  return context;
}

