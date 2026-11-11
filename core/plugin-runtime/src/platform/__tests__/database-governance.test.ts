/**
 * @module @kb-labs/plugin-runtime/platform/__tests__/database-governance
 *
 * Tests for the per-plugin governance layer that wraps `IDocumentDatabase`
 * and `IKVStore` adapters with namespacing + permission enforcement.
 *
 * Strategy:
 *  - Build behaviour against the real sqlite-backed adapters from
 *    `@kb-labs/adapters-sqlite` (in-memory). Mocks would only verify that
 *    we forwarded the call; the actual guarantee — "plugin A cannot read
 *    plugin B's data" — has to be checked at the storage layer.
 *  - One describe block per failure mode: missing permission, name
 *    validation, op classification, cross-plugin grants, namespacing,
 *    transactions, and install-time validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  InMemoryDocumentDatabase,
  InMemoryKVStore} from '@kb-labs/core-platform/inmemory';
import {
  createInMemoryDocumentDatabase,
  createInMemoryKVStore
} from '@kb-labs/core-platform/inmemory';
import { PermissionError } from '@kb-labs/plugin-contracts';
import type { PermissionSpec } from '@kb-labs/plugin-contracts';
import type { IDocumentTransaction, BaseDocument } from '@kb-labs/core-platform/adapters';
import {
  wrapDocumentDatabase,
  wrapKVStore,
  validateDatabaseGrants,
  type ManifestForGrantValidation,
} from '../database-governance.js';

interface Run extends BaseDocument {
  status: string;
  pluginTag?: string;
}

const docPerms = (perm: NonNullable<NonNullable<PermissionSpec['platform']>['database']>['document']): PermissionSpec =>
  ({ platform: { database: { document: perm } } });

const kvPerms = (): PermissionSpec =>
  ({ platform: { database: { kvStore: {} } } });

describe('wrapDocumentDatabase', () => {
  let raw: InMemoryDocumentDatabase;

  beforeEach(async () => {
    raw = createInMemoryDocumentDatabase();
    await raw.ensureCollection('workflow__runs');
    await raw.ensureCollection('auth__users');
  });

  afterEach(async () => {
    await raw.close();
  });

  describe('deny stub when permission is absent', () => {
    it('rejects every operation with PermissionError', async () => {
      const db = wrapDocumentDatabase(raw, 'workflow', {});
      await expect(db.find('runs', {})).rejects.toThrow(PermissionError);
      await expect(db.findById('runs', 'x')).rejects.toThrow(PermissionError);
      await expect(db.count('runs', {})).rejects.toThrow(PermissionError);
      await expect(db.insertOne('runs', {})).rejects.toThrow(PermissionError);
      await expect(db.insertMany('runs', [])).rejects.toThrow(PermissionError);
      await expect(db.updateOne('runs', {}, { $set: {} })).rejects.toThrow(PermissionError);
      await expect(db.updateMany('runs', {}, { $set: {} })).rejects.toThrow(PermissionError);
      await expect(db.updateById('runs', 'x', { $set: {} })).rejects.toThrow(PermissionError);
      await expect(db.deleteMany('runs', {})).rejects.toThrow(PermissionError);
      await expect(db.deleteById('runs', 'x')).rejects.toThrow(PermissionError);
      await expect(db.bulkWrite('runs', [])).rejects.toThrow(PermissionError);
      await expect(db.transaction(async () => {})).rejects.toThrow(PermissionError);
      await expect(db.ensureCollection('runs')).rejects.toThrow(PermissionError);
    });

    it('still allows ping() and close() so health-checks survive', async () => {
      const db = wrapDocumentDatabase(raw, 'workflow', {});
      const ping = await db.ping();
      expect(ping.ok).toBe(true);
      await db.close();
    });

    it('findStream throws on iteration, not on call', async () => {
      const db = wrapDocumentDatabase(raw, 'workflow', {});
      const iter = db.findStream('runs', {});
      let caught: unknown;
      try {
        for await (const _ of iter) { /* unreachable */ void _; }
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PermissionError);
    });
  });

  describe('name validation', () => {
    it('rejects collection names containing the namespace separator', () => {
      expect(() =>
        wrapDocumentDatabase(raw, 'workflow', docPerms({ owns: ['evil__name'] })),
      ).toThrow(/reserved separator/);
    });

    it('rejects empty collection name in owns', () => {
      expect(() =>
        wrapDocumentDatabase(raw, 'workflow', docPerms({ owns: [''] })),
      ).toThrow(/non-empty string/);
    });

    it('rejects duplicate names in owns', () => {
      expect(() =>
        wrapDocumentDatabase(raw, 'workflow', docPerms({ owns: ['runs', 'runs'] })),
      ).toThrow(/declared twice/);
    });

    it('rejects access entry whose collection clashes with owns', () => {
      expect(() =>
        wrapDocumentDatabase(
          raw,
          'workflow',
          docPerms({
            owns: ['runs'],
            access: [{ collection: 'runs', owner: 'auth', ops: ['read'] }],
          }),
        ),
      ).toThrow(/both owns and access/);
    });

    it('rejects access entry with empty ops', () => {
      expect(() =>
        wrapDocumentDatabase(
          raw,
          'workflow',
          docPerms({ access: [{ collection: 'users', owner: 'auth', ops: [] }] }),
        ),
      ).toThrow(/at least one op/);
    });
  });

  describe('owned collections', () => {
    it('routes a read on an owned collection to <pluginId>__<name>', async () => {
      // Plant a row directly under workflow__runs.
      await raw.insertOne<Run>('workflow__runs', { status: 'active', pluginTag: 'workflow' });
      const db = wrapDocumentDatabase(raw, 'workflow', docPerms({ owns: ['runs'] }));
      const rows = await db.find<Run>('runs', {});
      expect(rows).toHaveLength(1);
      expect(rows[0]!.pluginTag).toBe('workflow');
    });

    it('routes a write on an owned collection to <pluginId>__<name>', async () => {
      const db = wrapDocumentDatabase(raw, 'workflow', docPerms({ owns: ['runs'] }));
      await db.insertOne<Run>('runs', { status: 'queued' });
      // Verify the storage row landed in the namespaced collection.
      const inStorage = await raw.find<Run>('workflow__runs', {});
      expect(inStorage).toHaveLength(1);
      expect(inStorage[0]!.status).toBe('queued');
    });

    it('denies reads on a collection NOT in owns or access', async () => {
      const db = wrapDocumentDatabase(raw, 'workflow', docPerms({ owns: ['runs'] }));
      await expect(db.find('other', {})).rejects.toThrow(/no permission for collection 'other'/);
    });

    it('denies ensureCollection on owned collection without ddl.ownCollections', async () => {
      const db = wrapDocumentDatabase(raw, 'workflow', docPerms({ owns: ['runs'] }));
      await expect(db.ensureCollection('runs')).rejects.toThrow(/lacks ddl.ownCollections/);
    });

    it('allows ensureCollection when ddl.ownCollections is true', async () => {
      const db = wrapDocumentDatabase(
        raw,
        'workflow',
        docPerms({ owns: ['steps'], ddl: { ownCollections: true } }),
      );
      await expect(db.ensureCollection('steps')).resolves.not.toThrow();
      // Verify the namespaced collection was created on the underlying driver.
      await expect(raw.find('workflow__steps', {})).resolves.toEqual([]);
    });
  });

  describe('cross-plugin access grants', () => {
    it('allows a granted read into another plugin namespace', async () => {
      // auth owns "users" — plant data on auth side.
      await raw.insertOne<BaseDocument & { email: string }>('auth__users', { email: 'a@x' });

      const db = wrapDocumentDatabase(
        raw,
        'billing',
        docPerms({
          owns: ['invoices'],
          access: [{ collection: 'users', owner: 'auth', ops: ['read'] }],
        }),
      );
      const users = await db.find<BaseDocument & { email: string }>('users', {});
      expect(users).toHaveLength(1);
      expect(users[0]!.email).toBe('a@x');
    });

    it('denies a write on a read-only grant', async () => {
      const db = wrapDocumentDatabase(
        raw,
        'billing',
        docPerms({
          owns: ['invoices'],
          access: [{ collection: 'users', owner: 'auth', ops: ['read'] }],
        }),
      );
      await expect(db.insertOne('users', { email: 'x' })).rejects.toThrow(/lacks 'write'/);
    });

    it('allows write when grant includes write op', async () => {
      const db = wrapDocumentDatabase(
        raw,
        'billing',
        docPerms({
          access: [{ collection: 'users', owner: 'auth', ops: ['read', 'write'] }],
        }),
      );
      await db.insertOne<BaseDocument & { email: string }>('users', { email: 'b@x' });
      const rows = await raw.find<BaseDocument & { email: string }>('auth__users', {});
      expect(rows.map((r) => r.email)).toContain('b@x');
    });

    it('forbids DDL on a foreign-owned collection regardless of grant', async () => {
      const db = wrapDocumentDatabase(
        raw,
        'billing',
        docPerms({
          access: [{ collection: 'users', owner: 'auth', ops: ['read', 'write'] }],
          ddl: { ownCollections: true },
        }),
      );
      await expect(db.ensureCollection('users')).rejects.toThrow(/owned by another plugin/);
    });
  });

  describe('namespace isolation', () => {
    it('two plugins with the same collection name see disjoint data', async () => {
      await raw.ensureCollection('a__notes');
      await raw.ensureCollection('b__notes');

      const a = wrapDocumentDatabase(raw, 'a', docPerms({ owns: ['notes'] }));
      const b = wrapDocumentDatabase(raw, 'b', docPerms({ owns: ['notes'] }));

      await a.insertOne<BaseDocument & { msg: string }>('notes', { msg: 'from-a' });
      await b.insertOne<BaseDocument & { msg: string }>('notes', { msg: 'from-b' });

      const fromA = await a.find<BaseDocument & { msg: string }>('notes', {});
      const fromB = await b.find<BaseDocument & { msg: string }>('notes', {});
      expect(fromA).toHaveLength(1);
      expect(fromA[0]!.msg).toBe('from-a');
      expect(fromB).toHaveLength(1);
      expect(fromB[0]!.msg).toBe('from-b');
    });

    it('a plugin cannot read another plugin\'s data even when both own the same name', async () => {
      await raw.ensureCollection('a__notes');
      await raw.ensureCollection('b__notes');
      await raw.insertOne<BaseDocument & { secret: string }>('b__notes', { secret: 'b-only' });

      const a = wrapDocumentDatabase(raw, 'a', docPerms({ owns: ['notes'] }));
      const visible = await a.find<BaseDocument & { secret: string }>('notes', {});
      expect(visible).toHaveLength(0);
    });
  });

  describe('transactions', () => {
    it('enforces the same governance inside transaction()', async () => {
      const db = wrapDocumentDatabase(raw, 'workflow', docPerms({ owns: ['runs'] }));
      await expect(
        db.transaction(async (tx: IDocumentTransaction) => {
          await tx.find('other-plugin-collection', {});
        }),
      ).rejects.toThrow(/no permission for collection 'other-plugin-collection'/);
    });

    it('commits a namespaced write performed inside a transaction', async () => {
      const db = wrapDocumentDatabase(raw, 'workflow', docPerms({ owns: ['runs'] }));
      await db.transaction(async (tx: IDocumentTransaction) => {
        await tx.insertOne<Run>('runs', { status: 'queued' });
      });
      const rows = await raw.find<Run>('workflow__runs', {});
      expect(rows).toHaveLength(1);
    });
  });

  describe('bulkWrite', () => {
    it('namespaces every op in the batch and enforces write permission once', async () => {
      const db = wrapDocumentDatabase(raw, 'workflow', docPerms({ owns: ['runs'] }));
      const result = await db.bulkWrite<Run>('runs', [
        { type: 'insert', doc: { status: 'a' } },
        { type: 'insert', doc: { status: 'b' } },
      ]);
      expect(result.inserted).toBe(2);
      const inStorage = await raw.find<Run>('workflow__runs', {});
      expect(inStorage).toHaveLength(2);
    });

    it('denies bulkWrite when collection has read-only grant', async () => {
      const db = wrapDocumentDatabase(
        raw,
        'billing',
        docPerms({
          access: [{ collection: 'users', owner: 'auth', ops: ['read'] }],
        }),
      );
      await expect(
        db.bulkWrite('users', [{ type: 'insert', doc: {} }]),
      ).rejects.toThrow(/lacks 'write'/);
    });
  });
});

describe('wrapKVStore', () => {
  let raw: InMemoryKVStore;

  beforeEach(() => {
    raw = createInMemoryKVStore();
  });

  afterEach(async () => {
    await raw.close();
  });

  describe('deny stub when permission is absent', () => {
    it('rejects every operation', async () => {
      const kv = wrapKVStore(raw, 'workflow', {});
      await expect(kv.get('k')).rejects.toThrow(PermissionError);
      await expect(kv.getMany(['a'])).rejects.toThrow(PermissionError);
      await expect(kv.set('k', 'v')).rejects.toThrow(PermissionError);
      await expect(kv.setMany([{ key: 'k', value: 'v' }])).rejects.toThrow(PermissionError);
      await expect(kv.setIfNotExists('k', 'v')).rejects.toThrow(PermissionError);
      await expect(kv.delete('k')).rejects.toThrow(PermissionError);
      await expect(kv.exists('k')).rejects.toThrow(PermissionError);
      await expect(kv.cas('k', 1, 2)).rejects.toThrow(PermissionError);
      await expect(kv.incr('k')).rejects.toThrow(PermissionError);
      await expect(kv.ttl('k')).rejects.toThrow(PermissionError);
      await expect(kv.expire('k', 1000)).rejects.toThrow(PermissionError);
      await expect(kv.persist('k')).rejects.toThrow(PermissionError);
      // scan throws when iterated
      const iter = kv.scan('');
      let caught: unknown;
      try { for await (const _ of iter) { void _; } } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(PermissionError);
    });

    it('still allows ping/close', async () => {
      const kv = wrapKVStore(raw, 'workflow', {});
      expect((await kv.ping()).ok).toBe(true);
      await kv.close();
    });
  });

  describe('namespacing', () => {
    it('prefixes keys with <pluginId>: under the hood', async () => {
      const kv = wrapKVStore(raw, 'auth', kvPerms());
      await kv.set('session:abc', 'token-xyz');
      // Direct raw read on the storage layer confirms the prefix.
      const raw_val = await raw.get('auth:session:abc');
      expect(raw_val).toBe('token-xyz');
      // And the consumer-visible key is unchanged.
      expect(await kv.get('session:abc')).toBe('token-xyz');
    });

    it('two plugins cannot see each other\'s keys', async () => {
      const a = wrapKVStore(raw, 'a', kvPerms());
      const b = wrapKVStore(raw, 'b', kvPerms());
      await a.set('shared', 'a-value');
      await b.set('shared', 'b-value');
      expect(await a.get('shared')).toBe('a-value');
      expect(await b.get('shared')).toBe('b-value');
    });

    it('scan only yields keys from the calling plugin\'s namespace and strips the prefix', async () => {
      const a = wrapKVStore(raw, 'a', kvPerms());
      const b = wrapKVStore(raw, 'b', kvPerms());
      await a.set('x', 1);
      await a.set('y', 2);
      await b.set('x', 99);

      const visible: string[] = [];
      for await (const { key } of a.scan('')) {
        visible.push(key);
      }
      expect(visible.sort()).toEqual(['x', 'y']);
    });

    it('scan respects a prefix argument relative to the plugin namespace', async () => {
      const kv = wrapKVStore(raw, 'auth', kvPerms());
      await kv.set('session:a', 1);
      await kv.set('session:b', 2);
      await kv.set('other:c', 3);
      const keys: string[] = [];
      for await (const { key } of kv.scan('session:')) {
        keys.push(key);
      }
      expect(keys.sort()).toEqual(['session:a', 'session:b']);
    });

    it('getMany namespaces every key', async () => {
      const a = wrapKVStore(raw, 'a', kvPerms());
      const b = wrapKVStore(raw, 'b', kvPerms());
      await a.setMany([{ key: 'x', value: 1 }, { key: 'y', value: 2 }]);
      await b.set('x', 99);
      const got = await a.getMany<number>(['x', 'y', 'missing']);
      expect(got).toEqual([1, 2, null]);
    });
  });

  describe('atomic ops respect namespace', () => {
    it('cas operates on the namespaced key', async () => {
      const kv = wrapKVStore(raw, 'auth', kvPerms());
      await kv.set('lock', 'v1');
      expect(await kv.cas('lock', 'v1', 'v2')).toBe(true);
      expect(await kv.get('lock')).toBe('v2');
      // Direct raw check shows the prefix is in place.
      expect(await raw.get('auth:lock')).toBe('v2');
    });

    it('incr operates on the namespaced key', async () => {
      const kv = wrapKVStore(raw, 'metrics', kvPerms());
      await kv.incr('counter', 5);
      expect(await kv.get<number>('counter')).toBe(5);
      expect(await raw.get<number>('metrics:counter')).toBe(5);
    });

    it('expire/persist/ttl operate on the namespaced key', async () => {
      const kv = wrapKVStore(raw, 'auth', kvPerms());
      await kv.set('temp', 'v');
      await kv.expire('temp', 60_000);
      const ttl = await kv.ttl('temp');
      expect(ttl).toBeGreaterThan(0);
      expect(await kv.persist('temp')).toBe(true);
      expect(await kv.ttl('temp')).toBeNull();
    });
  });

  describe('input validation', () => {
    it('rejects empty key', async () => {
      const kv = wrapKVStore(raw, 'auth', kvPerms());
      await expect(kv.set('', 'v')).rejects.toThrow(/non-empty string/);
      await expect(kv.get('')).rejects.toThrow(/non-empty string/);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Install-time validator
// ────────────────────────────────────────────────────────────────────────────

describe('validateDatabaseGrants', () => {
  const auth: ManifestForGrantValidation = {
    id: 'auth',
    permissions: {
      platform: { database: { document: { owns: ['users', 'sessions'] } } },
    },
    exports: {
      collections: [
        { name: 'users', ops: ['read'] },
        { name: 'sessions' }, // default ['read']
      ],
    },
  };

  it('passes a plugin with no access grants', () => {
    const billing: ManifestForGrantValidation = {
      id: 'billing',
      permissions: { platform: { database: { document: { owns: ['invoices'] } } } },
    };
    const result = validateDatabaseGrants(billing, [auth]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('passes when grant matches an export', () => {
    const billing: ManifestForGrantValidation = {
      id: 'billing',
      permissions: {
        platform: {
          database: {
            document: {
              owns: ['invoices'],
              access: [{ collection: 'users', owner: 'auth', ops: ['read'] }],
            },
          },
        },
      },
    };
    const result = validateDatabaseGrants(billing, [auth]);
    expect(result.valid).toBe(true);
  });

  it('fails when the owner plugin is not installed', () => {
    const billing: ManifestForGrantValidation = {
      id: 'billing',
      permissions: {
        platform: {
          database: {
            document: {
              access: [{ collection: 'users', owner: 'ghost', ops: ['read'] }],
            },
          },
        },
      },
    };
    const result = validateDatabaseGrants(billing, [auth]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/'ghost'.*not installed/);
  });

  it('fails when the owner does not export the requested collection', () => {
    const billing: ManifestForGrantValidation = {
      id: 'billing',
      permissions: {
        platform: {
          database: {
            document: {
              access: [{ collection: 'tokens', owner: 'auth', ops: ['read'] }],
            },
          },
        },
      },
    };
    const result = validateDatabaseGrants(billing, [auth]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/does not export this collection/);
  });

  it('fails when requested ops exceed what the owner exports', () => {
    const billing: ManifestForGrantValidation = {
      id: 'billing',
      permissions: {
        platform: {
          database: {
            document: {
              access: [{ collection: 'users', owner: 'auth', ops: ['write'] }],
            },
          },
        },
      },
    };
    const result = validateDatabaseGrants(billing, [auth]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/owner only exports \[read\]/);
  });

  it('allows multi-op grants when the export covers both', () => {
    const authWithWrite: ManifestForGrantValidation = {
      ...auth,
      exports: { collections: [{ name: 'users', ops: ['read', 'write'] }] },
    };
    const admin: ManifestForGrantValidation = {
      id: 'admin',
      permissions: {
        platform: {
          database: {
            document: {
              access: [{ collection: 'users', owner: 'auth', ops: ['read', 'write'] }],
            },
          },
        },
      },
    };
    const result = validateDatabaseGrants(admin, [authWithWrite]);
    expect(result.valid).toBe(true);
  });

  it('rejects self-grants (owner = candidate.id)', () => {
    const selfRef: ManifestForGrantValidation = {
      id: 'self-ref',
      permissions: {
        platform: {
          database: {
            document: {
              access: [{ collection: 'runs', owner: 'self-ref', ops: ['read'] }],
            },
          },
        },
      },
    };
    const result = validateDatabaseGrants(selfRef, [selfRef]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/grants access on its own collection/);
  });

  it('reports multiple errors when several grants are broken', () => {
    const broken: ManifestForGrantValidation = {
      id: 'broken',
      permissions: {
        platform: {
          database: {
            document: {
              access: [
                { collection: 'users', owner: 'ghost', ops: ['read'] },
                { collection: 'tokens', owner: 'auth', ops: ['read'] },
              ],
            },
          },
        },
      },
    };
    const result = validateDatabaseGrants(broken, [auth]);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});
