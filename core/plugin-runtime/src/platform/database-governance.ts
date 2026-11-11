/**
 * @module @kb-labs/plugin-runtime/platform/database-governance
 *
 * Per-plugin governance for the document database and KV store adapters.
 *
 * The platform — not the adapter — owns access control. An adapter receives
 * the raw `IDocumentDatabase` / `IKVStore` and we wrap it once per plugin
 * with:
 *
 *  - **Collection / key namespacing.** Plugin `auth` writing `"users"`
 *    transparently lands on `auth__users`; plugin `billing` writing
 *    `"users"` lands on `billing__users`. Two plugins never collide on
 *    a naive name. For KV the prefix is `<pluginId>:`.
 *  - **Permission enforcement.** Reads are allowed on a collection only
 *    if it's in `owns` or covered by a `read` `access` grant. Writes
 *    require `write`. `ensureCollection` is a separate `ddl` privilege.
 *    Without the corresponding sub-permission the adapter is replaced
 *    with a deny stub.
 *  - **Cross-plugin grants.** An `access` entry references `{collection,
 *    owner, ops}`. The runtime trusts the install-time validator to have
 *    rejected grants without a matching `exports.collections` entry on
 *    the owner manifest; the wrapper itself only enforces the local view.
 *
 * Names cannot contain `__` (the namespace separator). `validateName`
 * rejects them at construction time so a typo can't smuggle a write into
 * another plugin's namespace.
 */

import { PermissionError } from '@kb-labs/plugin-contracts';
import type {
  IDocumentDatabase,
  IDocumentTransaction,
  IKVStore,
  BaseDocument,
  DocumentFilter,
  DocumentUpdate,
  FindOptions,
  ProjectOpts,
  SignalOpts,
  EnsureCollectionOpts,
  BulkOp,
  BulkResult,
  SetOpts,
} from '@kb-labs/core-platform/adapters';
import type { PermissionSpec } from '@kb-labs/plugin-contracts';

const NAMESPACE_SEPARATOR = '__';
const KV_NAMESPACE_SEPARATOR = ':';

function permissionDenied(pluginId: string, permission: string, message: string): PermissionError {
  return new PermissionError(message, { plugin: pluginId, permission });
}

/**
 * Reject namespace-reserved characters. Throws on construction rather than
 * on first use so misconfigured plugins fail at adapter assembly time.
 */
const validateName = (pluginId: string, kind: 'collection' | 'export', name: string): void => {
  if (!name || typeof name !== 'string') {
    throw permissionDenied(pluginId, 'platform.database.document', `${kind} name must be a non-empty string, got ${JSON.stringify(name)}`);
  }
  if (name.includes(NAMESPACE_SEPARATOR)) {
    throw permissionDenied(pluginId, 'platform.database.document', `${kind} '${name}' contains reserved separator '${NAMESPACE_SEPARATOR}'`);
  }
};

/**
 * Manifest plugin ids are scoped npm package names (`@kb-labs/steward`),
 * but the composed storage name reaches the adapter as a SQL identifier
 * (sqlite table name) — `@` and `/` aren't legal there. Sanitize only the
 * segment used for storage names; `pluginId` itself keeps its readable
 * form everywhere else (ACL lookups, error messages).
 */
const sanitizeForIdentifier = (pluginId: string): string =>
  pluginId.replace(/[^a-zA-Z0-9_]/g, '_');

interface CollectionAcl {
  /** Plugin owns this collection — full CRUD. */
  ownedBy: 'self';
  /** Resolved storage name (namespaced). */
  storageName: string;
}
interface AccessAcl {
  /** Collection lives in another plugin's namespace. */
  ownedBy: 'other';
  /** Operations granted by the owner export + this plugin's access entry. */
  ops: Set<'read' | 'write'>;
  /** Resolved storage name (namespaced under the owner). */
  storageName: string;
}
type Acl = CollectionAcl | AccessAcl;

/**
 * Compile the plugin's database permissions into a lookup table once at
 * wrap time — every per-call check is then an O(1) map lookup instead of
 * a linear scan over the permission spec.
 */
function compileDocumentAcl(
  pluginId: string,
  perm: NonNullable<NonNullable<PermissionSpec['platform']>['database']>['document'],
): { acl: Map<string, Acl>; allowDDL: boolean } {
  const acl = new Map<string, Acl>();
  const storagePluginId = sanitizeForIdentifier(pluginId);
  for (const own of perm?.owns ?? []) {
    validateName(pluginId, 'collection', own);
    if (acl.has(own)) {
      throw permissionDenied(pluginId, 'platform.database.document', `Collection '${own}' declared twice in owns for plugin '${pluginId}'`);
    }
    acl.set(own, { ownedBy: 'self', storageName: `${storagePluginId}${NAMESPACE_SEPARATOR}${own}` });
  }
  for (const grant of perm?.access ?? []) {
    validateName(pluginId, 'collection', grant.collection);
    validateName(pluginId, 'collection', grant.owner);
    if (acl.has(grant.collection)) {
      // The plugin already owns this name — own > access. A grant on an owned
      // name is a misconfiguration and we'd rather make the operator fix it.
      throw permissionDenied(pluginId, 'platform.database.document', `Collection '${grant.collection}' appears in both owns and access for plugin '${pluginId}'`);
    }
    if (!Array.isArray(grant.ops) || grant.ops.length === 0) {
      throw permissionDenied(pluginId, 'platform.database.document', `access grant for '${grant.collection}' must declare at least one op (read/write)`);
    }
    acl.set(grant.collection, {
      ownedBy: 'other',
      ops: new Set(grant.ops),
      storageName: `${sanitizeForIdentifier(grant.owner)}${NAMESPACE_SEPARATOR}${grant.collection}`,
    });
  }
  return { acl, allowDDL: perm?.ddl?.ownCollections === true };
}

type DocOp = 'read' | 'write' | 'ddl';

/**
 * Resolve a plugin-visible collection name to the storage name + verify the
 * requested operation is allowed.
 */
function resolveCollection(
  pluginId: string,
  acl: Map<string, Acl>,
  allowDDL: boolean,
  visibleName: string,
  op: DocOp,
): string {
  const entry = acl.get(visibleName);
  if (!entry) {
    throw permissionDenied(pluginId, `platform.database.document.${op}`, `Plugin '${pluginId}' has no permission for collection '${visibleName}' (not in owns/access)`);
  }
  if (entry.ownedBy === 'self') {
    if (op === 'ddl' && !allowDDL) {
      throw permissionDenied(pluginId, 'platform.database.document.ddl', `Plugin '${pluginId}' lacks ddl.ownCollections — cannot ensureCollection('${visibleName}')`);
    }
    return entry.storageName;
  }
  // Cross-plugin access
  if (op === 'ddl') {
    throw permissionDenied(pluginId, 'platform.database.document.ddl', `Plugin '${pluginId}' cannot run DDL on '${visibleName}': collection is owned by another plugin`);
  }
  if (!entry.ops.has(op)) {
    throw permissionDenied(pluginId, `platform.database.document.${op}`, `Plugin '${pluginId}' lacks '${op}' on '${visibleName}' (granted: ${[...entry.ops].join(',')})`);
  }
  return entry.storageName;
}

/**
 * Wrap `IDocumentDatabase` for one plugin. Every method maps the
 * user-visible collection name to the storage name and enforces the
 * read/write/ddl distinction.
 *
 * Returns a deny-stub when the plugin did not declare
 * `permissions.platform.database.document`.
 */
export function wrapDocumentDatabase(
  raw: IDocumentDatabase,
  pluginId: string,
  permissions: PermissionSpec,
): IDocumentDatabase {
  const docPerm = permissions.platform?.database?.document;
  if (!docPerm) {
    return createDocumentDenyStub(pluginId);
  }
  const { acl, allowDDL } = compileDocumentAcl(pluginId, docPerm);

  const resolveRead = (c: string): string => resolveCollection(pluginId, acl, allowDDL, c, 'read');
  const resolveWrite = (c: string): string => resolveCollection(pluginId, acl, allowDDL, c, 'write');
  const resolveDdl = (c: string): string => resolveCollection(pluginId, acl, allowDDL, c, 'ddl');

  // Every async method is declared with the `async` keyword so a sync
  // `PermissionError` from resolve*() is converted into a rejected Promise,
  // matching the contract callers rely on (`await db.find(...)`).
  const wrap: IDocumentDatabase = {
    async find<T extends BaseDocument, P = T>(c: string, f: DocumentFilter<T>, o?: FindOptions & ProjectOpts<T, P> & SignalOpts): Promise<P[]> {
      return raw.find<T, P>(resolveRead(c), f, o);
    },
    // findStream stays a generator — the resolve check happens up-front but
    // any sync throw inside the generator body is delivered on the first
    // `.next()` call (i.e. when the consumer starts iterating), which is
    // what `for await` callers expect.
    findStream<T extends BaseDocument, P = T>(
      c: string,
      f: DocumentFilter<T>,
      o?: FindOptions & ProjectOpts<T, P> & SignalOpts & { batchSize?: number },
    ): AsyncIterable<P> {
      const resolved = resolveRead(c);
      return raw.findStream<T, P>(resolved, f, o);
    },
    async findById<T extends BaseDocument>(c: string, id: string, o?: SignalOpts): Promise<T | null> {
      return raw.findById<T>(resolveRead(c), id, o);
    },
    async count<T extends BaseDocument>(c: string, f: DocumentFilter<T>, o?: SignalOpts): Promise<number> {
      return raw.count<T>(resolveRead(c), f, o);
    },

    async insertOne<T extends BaseDocument>(c: string, doc: Omit<T, 'id' | 'createdAt' | 'updatedAt'>, o?: SignalOpts): Promise<T> {
      return raw.insertOne<T>(resolveWrite(c), doc, o);
    },
    async insertMany<T extends BaseDocument>(c: string, docs: Array<Omit<T, 'id' | 'createdAt' | 'updatedAt'>>, o?: SignalOpts): Promise<T[]> {
      return raw.insertMany<T>(resolveWrite(c), docs, o);
    },
    async updateOne<T extends BaseDocument>(c: string, f: DocumentFilter<T>, u: DocumentUpdate<T>, o?: SignalOpts & { upsert?: boolean }): Promise<T | null> {
      return raw.updateOne<T>(resolveWrite(c), f, u, o);
    },
    async updateMany<T extends BaseDocument>(c: string, f: DocumentFilter<T>, u: DocumentUpdate<T>, o?: SignalOpts): Promise<number> {
      return raw.updateMany<T>(resolveWrite(c), f, u, o);
    },
    async updateById<T extends BaseDocument>(c: string, id: string, u: DocumentUpdate<T>, o?: SignalOpts): Promise<T | null> {
      return raw.updateById<T>(resolveWrite(c), id, u, o);
    },
    async deleteMany<T extends BaseDocument>(c: string, f: DocumentFilter<T>, o?: SignalOpts): Promise<number> {
      return raw.deleteMany<T>(resolveWrite(c), f, o);
    },
    async deleteById(c: string, id: string, o?: SignalOpts): Promise<boolean> {
      return raw.deleteById(resolveWrite(c), id, o);
    },
    async bulkWrite<T extends BaseDocument>(c: string, ops: Array<BulkOp<T>>, o?: SignalOpts): Promise<BulkResult> {
      // Every op in the batch is implicitly write on the same collection.
      return raw.bulkWrite<T>(resolveWrite(c), ops, o);
    },

    async transaction<R>(fn: (tx: IDocumentTransaction) => Promise<R>): Promise<R> {
      return raw.transaction<R>(async (innerTx) =>
        fn(makeGovernedTx(innerTx, pluginId, acl, allowDDL)),
      );
    },

    async ensureCollection(name: string, opts?: EnsureCollectionOpts) {
      return raw.ensureCollection(resolveDdl(name), opts);
    },

    ping: () => raw.ping(),
    close: (opts?: { drainTimeoutMs?: number }) => raw.close(opts),
  };

  return wrap;
}

/**
 * Same governance applied inside a transaction. Re-uses the parent's ACL
 * map so a plugin cannot escape its scope by opening a transaction.
 */
function makeGovernedTx(
  raw: IDocumentTransaction,
  pluginId: string,
  acl: Map<string, Acl>,
  allowDDL: boolean,
): IDocumentTransaction {
  const resolveRead = (c: string): string => resolveCollection(pluginId, acl, allowDDL, c, 'read');
  const resolveWrite = (c: string): string => resolveCollection(pluginId, acl, allowDDL, c, 'write');

  return {
    find<T extends BaseDocument, P = T>(c: string, f: DocumentFilter<T>, o?: FindOptions & ProjectOpts<T, P> & SignalOpts): Promise<P[]> {
      return raw.find<T, P>(resolveRead(c), f, o);
    },
    findById<T extends BaseDocument>(c: string, id: string, o?: SignalOpts): Promise<T | null> {
      return raw.findById<T>(resolveRead(c), id, o);
    },
    count<T extends BaseDocument>(c: string, f: DocumentFilter<T>, o?: SignalOpts): Promise<number> {
      return raw.count<T>(resolveRead(c), f, o);
    },
    insertOne<T extends BaseDocument>(c: string, doc: Omit<T, 'id' | 'createdAt' | 'updatedAt'>, o?: SignalOpts): Promise<T> {
      return raw.insertOne<T>(resolveWrite(c), doc, o);
    },
    insertMany<T extends BaseDocument>(c: string, docs: Array<Omit<T, 'id' | 'createdAt' | 'updatedAt'>>, o?: SignalOpts): Promise<T[]> {
      return raw.insertMany<T>(resolveWrite(c), docs, o);
    },
    updateOne<T extends BaseDocument>(c: string, f: DocumentFilter<T>, u: DocumentUpdate<T>, o?: SignalOpts & { upsert?: boolean }): Promise<T | null> {
      return raw.updateOne<T>(resolveWrite(c), f, u, o);
    },
    updateMany<T extends BaseDocument>(c: string, f: DocumentFilter<T>, u: DocumentUpdate<T>, o?: SignalOpts): Promise<number> {
      return raw.updateMany<T>(resolveWrite(c), f, u, o);
    },
    updateById<T extends BaseDocument>(c: string, id: string, u: DocumentUpdate<T>, o?: SignalOpts): Promise<T | null> {
      return raw.updateById<T>(resolveWrite(c), id, u, o);
    },
    deleteMany<T extends BaseDocument>(c: string, f: DocumentFilter<T>, o?: SignalOpts): Promise<number> {
      return raw.deleteMany<T>(resolveWrite(c), f, o);
    },
    deleteById(c: string, id: string, o?: SignalOpts): Promise<boolean> {
      return raw.deleteById(resolveWrite(c), id, o);
    },
  };
}

/**
 * Wrap `IKVStore` for one plugin. Keys are transparently prefixed with
 * `<pluginId>:`. `scan` strips the prefix back off so the plugin sees the
 * keys it actually wrote. Cross-plugin access is not supported.
 *
 * Returns a deny-stub if `permissions.platform.database.kvStore` is absent.
 */
export function wrapKVStore(
  raw: IKVStore,
  pluginId: string,
  permissions: PermissionSpec,
): IKVStore {
  const kvPerm = permissions.platform?.database?.kvStore;
  if (!kvPerm) {
    return createKVDenyStub(pluginId);
  }
  const ns = `${pluginId}${KV_NAMESPACE_SEPARATOR}`;
  const validateKey = (k: string): void => {
    if (!k || typeof k !== 'string') {
      throw permissionDenied(pluginId, 'platform.database.kvStore', 'KV key must be a non-empty string');
    }
  };
  const prefix = (k: string): string => { validateKey(k); return ns + k; };
  const strip = (k: string): string => k.startsWith(ns) ? k.slice(ns.length) : k;

  // Async wrappers convert sync `validateKey` throws into rejected promises,
  // matching the IKVStore contract (callers `await` every operation).
  return {
    get: async <T = unknown>(k: string, o?: SignalOpts) => raw.get<T>(prefix(k), o),
    getMany: async <T = unknown>(keys: string[], o?: SignalOpts) =>
      raw.getMany<T>(keys.map(prefix), o),
    set: async <T = unknown>(k: string, v: T, o?: SetOpts) => raw.set<T>(prefix(k), v, o),
    setMany: async <T = unknown>(entries: Array<{ key: string; value: T; ttlMs?: number }>, o?: SignalOpts) =>
      raw.setMany<T>(entries.map((e) => ({ ...e, key: prefix(e.key) })), o),
    setIfNotExists: async <T = unknown>(k: string, v: T, o?: { ttlMs?: number } & SignalOpts) =>
      raw.setIfNotExists<T>(prefix(k), v, o),
    delete: async (k: string, o?: SignalOpts) => raw.delete(prefix(k), o),
    exists: async (k: string, o?: SignalOpts) => raw.exists(prefix(k), o),
    cas: async <T = unknown>(k: string, expected: T, next: T, o?: { ttlMs?: number } & SignalOpts) =>
      raw.cas<T>(prefix(k), expected, next, o),
    incr: async (k: string, delta?: number, o?: { ttlMs?: number } & SignalOpts) =>
      raw.incr(prefix(k), delta, o),
    ttl: async (k: string) => raw.ttl(prefix(k)),
    expire: async (k: string, ms: number) => raw.expire(prefix(k), ms),
    persist: async (k: string) => raw.persist(prefix(k)),
    scan: async function* (prefixArg?: string, o?: { batchSize?: number } & SignalOpts) {
      const scanPrefix = prefixArg === undefined ? ns : ns + prefixArg;
      for await (const { key, value } of raw.scan(scanPrefix, o)) {
        yield { key: strip(key), value };
      }
    },
    ping: () => raw.ping(),
    close: (opts?: { drainTimeoutMs?: number }) => raw.close(opts),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Deny stubs
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a deny stub whose methods reject (rather than synchronously throw).
 * Adapter callers consistently `await` results, so a sync throw bypasses
 * `.catch` / `expect(...).rejects` and surfaces as an uncaught exception
 * — predictable async rejection keeps error handling uniform.
 */
function createDocumentDenyStub(pluginId: string): IDocumentDatabase {
  const reason = "Document database access denied: plugin did not declare `permissions.platform.database.document`";
  const denyAsync = async (): Promise<never> => { throw permissionDenied(pluginId, 'platform.database.document', reason); };

  const denyIter = async function* (): AsyncIterable<never> { throw permissionDenied(pluginId, 'platform.database.document', reason); };
  return {
    find: denyAsync as never,
    findStream: denyIter as never,
    findById: denyAsync as never,
    count: denyAsync as never,
    insertOne: denyAsync as never,
    insertMany: denyAsync as never,
    updateOne: denyAsync as never,
    updateMany: denyAsync as never,
    updateById: denyAsync as never,
    deleteMany: denyAsync as never,
    deleteById: denyAsync as never,
    bulkWrite: denyAsync as never,
    transaction: denyAsync as never,
    ensureCollection: denyAsync as never,
    // ping/close are safe — health-check loops still need to succeed.
    ping: async () => ({ ok: true, latencyMs: 0 }),
    close: async () => {},
  };
}

function createKVDenyStub(pluginId: string): IKVStore {
  const reason = "KV store access denied: plugin did not declare `permissions.platform.database.kvStore`";
  const denyAsync = async (): Promise<never> => { throw permissionDenied(pluginId, 'platform.database.kvStore', reason); };

  const denyIter = async function* (): AsyncIterable<never> { throw permissionDenied(pluginId, 'platform.database.kvStore', reason); };
  return {
    get: denyAsync as never,
    getMany: denyAsync as never,
    set: denyAsync as never,
    setMany: denyAsync as never,
    setIfNotExists: denyAsync as never,
    delete: denyAsync as never,
    exists: denyAsync as never,
    cas: denyAsync as never,
    incr: denyAsync as never,
    ttl: denyAsync as never,
    expire: denyAsync as never,
    persist: denyAsync as never,
    scan: denyIter as never,
    ping: async () => ({ ok: true, latencyMs: 0 }),
    close: async () => {},
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Install-time validator (cross-plugin grants)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Result of validating a plugin's database grants against the set of
 * installed plugins.
 *
 * `valid: true` means every cross-plugin `access` entry has a matching
 * `exports.collections` declaration on the owner with the requested ops.
 * `valid: false` carries a human-readable list of mismatches.
 */
export interface DatabaseGrantValidation {
  valid: boolean;
  errors: string[];
}

/** Minimal manifest shape the validator needs — keeps it decoupled from full ManifestV3. */
export interface ManifestForGrantValidation {
  id: string;
  permissions?: PermissionSpec;
  exports?: {
    collections?: Array<{
      name: string;
      ops?: Array<'read' | 'write'>;
    }>;
  };
}

/**
 * Validate a candidate plugin's database access grants against the manifests
 * of every plugin currently in the installation set (including itself).
 *
 * Rules enforced:
 *  - Every `access` grant must reference a plugin in `installedPlugins`.
 *  - The referenced plugin must declare a matching `exports.collections`
 *    entry — same `name`, and the export's `ops` must be a superset of the
 *    consumer's requested `ops`.
 *  - The grant's `owner` field must match the manifest id (catches typos
 *    like `auth-svc` vs `auth`).
 *
 * Self-grants (owner = candidate.id) are rejected — use `owns` instead.
 *
 * The validator is pure: it doesn't touch the filesystem or the runtime.
 * Plug it into the install pipeline (kb-create install, marketplace
 * install) to fail-fast before the plugin ever reaches the platform.
 */
export function validateDatabaseGrants(
  candidate: ManifestForGrantValidation,
  installedPlugins: ReadonlyArray<ManifestForGrantValidation>,
): DatabaseGrantValidation {
  const errors: string[] = [];
  const accessGrants = candidate.permissions?.platform?.database?.document?.access ?? [];

  if (accessGrants.length === 0) {
    return { valid: true, errors };
  }

  const byId = new Map<string, ManifestForGrantValidation>();
  for (const m of installedPlugins) {
    byId.set(m.id, m);
  }
  // Ensure the candidate itself participates in the lookup so a self-grant
  // is reported with the right error rather than "owner not installed".
  byId.set(candidate.id, candidate);

  for (const grant of accessGrants) {
    if (grant.owner === candidate.id) {
      errors.push(
        `Plugin '${candidate.id}' grants access on its own collection '${grant.collection}'; use 'owns' instead.`,
      );
      continue;
    }
    const owner = byId.get(grant.owner);
    if (!owner) {
      errors.push(
        `Plugin '${candidate.id}' requests access to '${grant.collection}' from '${grant.owner}', but that plugin is not installed.`,
      );
      continue;
    }
    const exported = (owner.exports?.collections ?? []).find((e) => e.name === grant.collection);
    if (!exported) {
      errors.push(
        `Plugin '${candidate.id}' requests access to '${grant.collection}' from '${grant.owner}', but the owner does not export this collection.`,
      );
      continue;
    }
    // Owner-declared ops default to ['read']. Consumer-requested ops must be a subset.
    const exportedOps = new Set(exported.ops ?? ['read']);
    for (const op of grant.ops) {
      if (!exportedOps.has(op)) {
        errors.push(
          `Plugin '${candidate.id}' requests '${op}' on '${grant.collection}' from '${grant.owner}', but the owner only exports [${[...exportedOps].join(', ')}].`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
