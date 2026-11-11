/**
 * Tests for evaluateAuthReadiness.
 *
 * The state this exists to catch: auth enabled, no active tenant-admin —
 * login is impossible and every failure looks identical (CD-8). Each case
 * builds the real stores, so "active admin" means the same thing here as at
 * login time (membership AND active user in the right tenant).
 */

import { createServer } from 'node:http';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createInMemoryDocumentDatabase } from '@kb-labs/sdk/testing';
import { UsersStore } from '../users-store.js';
import { CredentialsStore } from '../credentials-store.js';
import { MembershipsStore } from '../memberships-store.js';
import { ensureBootstrapAdmin } from '../bootstrap-admin.js';
import { evaluateAuthReadiness, type AuthReadinessInput } from '../auth-readiness.js';
import { ProviderRegistry } from '../provider-registry.js';
import { createOidcProvider } from '../providers/oidc.js';

const TENANT = 'kblabs-cloud';
const EMAIL = 'admin@kblabs.ru';

let users: UsersStore;
let credentials: CredentialsStore;
let memberships: MembershipsStore;

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

beforeEach(() => {
  const docs = createInMemoryDocumentDatabase();
  users = new UsersStore(docs);
  credentials = new CredentialsStore(docs);
  memberships = new MembershipsStore(docs);
});

const evaluate = (overrides: Partial<AuthReadinessInput> = {}) =>
  evaluateAuthReadiness({
    authEnabled: true,
    loopbackOnly: false,
    tenantId: TENANT,
    jwtSecretIsDefault: false,
    bootstrap: { status: 'provisioned', email: EMAIL },
    users,
    memberships,
    credentials,
    providers: [{ id: 'email-password', kind: 'password', operational: { state: 'operational', checkedAt: 0 } }],
    ...overrides,
  });

const seedAdmin = async (userId = 'u1', status: 'active' | 'disabled' = 'active', tenantId = TENANT) => {
  await users.create({ userId, tenantId, email: `${userId}@x.test`, status });
  await credentials.setCredential({ userId, providerId: 'email-password', hash: 'test-hash' });
  await memberships.addMembership({ userId, tenantId, groupId: 'tenant-admin' });
};

describe('auth enabled', () => {
  it('is ok with one active admin and a real secret', async () => {
    await seedAdmin();
    const r = await evaluate({ providers: [{ id: 'email-password', kind: 'password', operational: { state: 'operational', checkedAt: 0 } }] });
    expect(r).toMatchObject({ ok: true, activeAdmins: 1, issues: [] });
  });

  it('empty database → no_active_admin error with a copy-pasteable fix', async () => {
    const r = await evaluate({ bootstrap: { status: 'not-configured', email: EMAIL } });

    expect(r.ok).toBe(false);
    expect(r.activeAdmins).toBe(0);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ code: 'no_active_admin', severity: 'error' });
    expect(r.issues[0]!.hint).toContain(`kb-create doctor --recover --email ${EMAIL} --tenant ${TENANT}`);
  });

  it('falls back to a placeholder email in the hint when none is configured', async () => {
    const r = await evaluate({ bootstrap: { status: 'not-configured' } });
    expect(r.issues[0]!.hint).toContain('--email <admin-email>');
  });

  // case: S-222.9
  it('uses real OIDC discovery state and retains valid readiness until its cached result expires', async () => {
    await users.create({ userId: 'sso', tenantId: TENANT, email: 'sso@x.test', status: 'active' });
    await memberships.addMembership({ userId: 'sso', tenantId: TENANT, groupId: 'tenant-admin' });
    const issuer = 'https://corp.example.test';
    let mode: 'ready' | 'unreachable' | 'invalid' = 'ready';
    let discoveryRequests = 0;
    const server = createServer((_request, response) => {
      discoveryRequests += 1;
      if (mode === 'unreachable') {
        response.writeHead(503).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        issuer: mode === 'invalid' ? 'https://other.example.test' : issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('OIDC stub did not bind a TCP port'); }
    const fetchStub: typeof fetch = (input, init) => {
      const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return fetch(`http://127.0.0.1:${address.port}${target.pathname}`, init);
    };
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const createRegistry = async () => {
      const registry = new ProviderRegistry();
      registry.register(createOidcProvider({
        type: 'oidc', id: 'corp', issuer, clientId: 'client', clientSecret: 'test-secret',
      }, {
        users: { findByEmailTenant: async () => null },
        credentials: { getCredential: async () => null },
        tenantId: TENANT,
        bcryptCost: 4,
        logger: { warn: () => undefined, info: () => undefined, error: () => undefined },
        fetch: fetchStub,
      }));
      return registry;
    };
    try {
      const registry = await createRegistry();
      const readyProviders = await registry.operationalList();
      expect(await evaluate({ providers: readyProviders, bootstrap: { status: 'not-configured' } }))
        .toMatchObject({ ok: true, activeAdmins: 1 });
      expect(discoveryRequests).toBe(1);

      mode = 'unreachable';
      now += 30_000;
      expect(await evaluate({ providers: await registry.operationalList(), bootstrap: { status: 'not-configured' } }))
        .toMatchObject({ ok: true, activeAdmins: 1 });
      expect(discoveryRequests).toBe(1);

      now += 30_001;
      const unreachable = await evaluate({ providers: await registry.operationalList(), bootstrap: { status: 'not-configured' } });
      expect(unreachable).toMatchObject({ ok: false, activeAdmins: 0, issues: expect.arrayContaining([
        expect.objectContaining({ code: 'login_provider_unavailable', providerId: 'corp', failure: 'unreachable' }),
      ]) });
      expect(JSON.stringify(unreachable)).not.toContain(issuer);

      mode = 'invalid';
      const invalidRegistry = await createRegistry();
      const invalid = await evaluate({ providers: await invalidRegistry.operationalList(), bootstrap: { status: 'not-configured' } });
      expect(invalid).toMatchObject({ ok: false, activeAdmins: 0, issues: expect.arrayContaining([
        expect.objectContaining({ code: 'login_provider_unavailable', providerId: 'corp', failure: 'invalid-discovery' }),
      ]) });
      await credentials.setCredential({ userId: 'sso', providerId: 'email-password', hash: 'test-hash' });
      expect(await evaluate({ providers: [{ id: 'email-password', kind: 'password', operational: { state: 'operational', checkedAt: now } }], bootstrap: { status: 'not-configured' } }))
        .toMatchObject({ ok: true, activeAdmins: 1 });
    } finally {
      nowSpy.mockRestore();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it('a disabled admin does not count', async () => {
    await seedAdmin('u1', 'disabled');
    const r = await evaluate();
    expect(r.activeAdmins).toBe(0);
    expect(r.issues.map((i) => i.code)).toContain('no_active_admin');
  });

  it('a tenant-member does not count as an admin', async () => {
    await users.create({ userId: 'm1', tenantId: TENANT, email: 'm1@x.test', status: 'active' });
    await memberships.addMembership({ userId: 'm1', tenantId: TENANT, groupId: 'tenant-member' });
    expect((await evaluate()).activeAdmins).toBe(0);
  });

  it("an admin of another tenant does not count", async () => {
    await seedAdmin('other', 'active', 'other-tenant');
    expect((await evaluate()).activeAdmins).toBe(0);
  });

  it('a dangling membership (user deleted) does not count and does not throw', async () => {
    await memberships.addMembership({ userId: 'ghost', tenantId: TENANT, groupId: 'tenant-admin' });
    expect((await evaluate()).activeAdmins).toBe(0);
  });

  it('counts several active admins', async () => {
    await seedAdmin('a');
    await seedAdmin('b');
    expect((await evaluate()).activeAdmins).toBe(2);
  });
});

describe('bootstrap status', () => {
  it('failed → bootstrap_failed error, even when an admin exists', async () => {
    await seedAdmin();
    const r = await evaluate({ bootstrap: { status: 'failed', email: EMAIL } });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(['bootstrap_failed']);
  });

  it('exists-non-active → warning, plus the error when that leaves no admin', async () => {
    await seedAdmin('u1', 'disabled');
    const r = await evaluate({ bootstrap: { status: 'exists-non-active', email: EMAIL } });
    expect(r.issues.map((i) => `${i.code}:${i.severity}`)).toEqual([
      'no_active_admin:error',
      'bootstrap_user_inactive:warning',
    ]);
  });
});

describe('jwt secret', () => {
  it('default secret on a reachable bind is an error', async () => {
    await seedAdmin();
    const r = await evaluate({ jwtSecretIsDefault: true, loopbackOnly: false });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: 'jwt_secret_default', severity: 'error' });
  });

  it('default secret on loopback is an error because every install needs a private secret', async () => {
    await seedAdmin();
    const r = await evaluate({ jwtSecretIsDefault: true, loopbackOnly: true });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: 'jwt_secret_default', severity: 'error' });
  });
});

describe('auth disabled (solo/local)', () => {
  it('does not require an admin but still rejects the shared default secret', async () => {
    const r = await evaluate({ authEnabled: false, jwtSecretIsDefault: true, bootstrap: { status: 'not-configured' } });
    expect(r).toMatchObject({ ok: false, authEnabled: false, activeAdmins: 0 });
    expect(r.issues.map((issue) => issue.code)).toEqual(['jwt_secret_default']);
  });
});

describe('the seeded-by-bootstrap path', () => {
  it('a bootstrap-provisioned admin makes a fresh install ready', async () => {
    const status = await ensureBootstrapAdmin({
      bootstrap: { adminEmail: EMAIL, adminPassword: 'long-enough-password', tenantId: TENANT },
      users, credentials, memberships, providers: [{ id: 'email-password', kind: 'password', operational: { state: 'operational', checkedAt: 0 } }], bcryptCost: 4, logger,
    });
    expect(status).toBe('provisioned');
    expect(await evaluate({ bootstrap: { status, email: EMAIL } })).toMatchObject({ ok: true, activeAdmins: 1 });
  });

  it('never leaks secret material in its output', async () => {
    const r = await evaluate({ jwtSecretIsDefault: true });
    expect(JSON.stringify(r)).not.toMatch(/dev-insecure-secret|password|hash/i);
  });
});
