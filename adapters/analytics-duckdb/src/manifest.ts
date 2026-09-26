/**
 * @module @kb-labs/adapters-analytics-duckdb/manifest
 * Adapter manifest for DuckDB analytics adapter.
 */

import type { AdapterManifest } from '@kb-labs/sdk/adapters';

export const manifest: AdapterManifest = {
  manifestVersion: '1.0.0',
  id: 'analytics-duckdb',
  name: 'DuckDB Analytics',
  version: '0.1.0',
  description: 'DuckDB-based analytics adapter — SQL-native time-series, groupBy, breakdownBy, metrics filtering',
  author: 'KB Labs Team',
  license: 'KBPL-1.1',
  type: 'core',
  implements: 'IAnalytics',
  contexts: ['workspace', 'analytics'],
  capabilities: {
    search: true,
    custom: {
      offline: true,
      stats: true,
      sql: true,
      groupBy: true,
      breakdownBy: true,
    },
  },
  configSchema: {
    dbPath: {
      type: 'string',
      description: 'Path to the DuckDB database file (default: <KB_HOME>/state/<projectId>/analytics/analytics.duckdb)',
    },
  },
};
