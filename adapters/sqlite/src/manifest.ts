/**
 * @module @kb-labs/adapters-sqlite/manifest
 *
 * Adapter manifest for SQLite-backed document, key-value, and vector stores.
 *
 * The package ships document, KV, and vector stores backed by
 * `better-sqlite3`.
 */

import type { AdapterManifest } from '@kb-labs/sdk/adapters';

export const manifest: AdapterManifest = {
  schema: 'kb.adapter/1',
  manifestVersion: '1.0.0',
  id: 'sqlite-stores',
  name: 'SQLite Document + KV',
  version: '2.0.0',
  description:
    'Embedded sqlite-backed storage pair: IDocumentDatabase and IKVStore, sharing a single file and connection.',
  author: 'KB Labs Team',
  license: 'KBPL-1.1',
  type: 'core',
  // One package supplies independent SQLite-backed platform stores.
  implements: ['IDocumentDatabase', 'IKVStore', 'IVectorStore'],
  networkRequired: false,
  defaultFor: { documentDatabase: [], kvStore: ['kv'], vectorStore: ['vector-store'] },
  contexts: ['workspace', 'platformData'],
  capabilities: {
    transactions: true,
    batch: true,
    custom: {
      json: true,
      ttl: true,
      indexes: true,
    },
  },
  configSchema: {
    filename: {
      type: 'string',
      description: 'Database file path (use :memory: for in-memory database)',
      pathBase: 'platformData',
      defaultPath: { root: 'projectState', segments: ['database', 'kb.sqlite'] },
      specialValues: [':memory:'],
    },
    vectorFilename: {
      type: 'string',
      description: 'Vector database path (use :memory: for an in-memory store)',
      defaultPath: { root: 'projectState', segments: ['vector-store', 'vectors.sqlite'] },
      specialValues: [':memory:'],
    },
    readonly: {
      type: 'boolean',
      default: false,
      description: 'Open database in readonly mode',
    },
    ttlSweepIntervalMs: {
      type: 'number',
      default: 30000,
      description: 'Background TTL sweep interval (ms). 0 disables the sweeper.',
    },
  },
};
