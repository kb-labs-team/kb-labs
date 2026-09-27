/**
 * @module @kb-labs/adapters-analytics-sqlite/manifest
 * Adapter manifest for SQLite analytics adapter.
 */

import type { AdapterManifest } from '@kb-labs/sdk/adapters';

export const manifest: AdapterManifest = {
  manifestVersion: '1.0.0',
  id: 'analytics-sqlite',
  name: 'SQLite Analytics',
  version: '0.1.0',
  description: 'SQLite-based analytics adapter — concurrent writes, WAL mode, SQL analytics, no lock issues',
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
      concurrent: true,
    },
  },
  configSchema: {
    dbPath: {
      type: 'string',
      description: 'Path to the SQLite database file (relative to workspace root) (default: <KB_HOME>/state/<projectId>/analytics/analytics.sqlite)',
    },
    filename: {
      type: 'string',
      description: 'Alias for dbPath — accepted for config compatibility',
    },
  },
};
