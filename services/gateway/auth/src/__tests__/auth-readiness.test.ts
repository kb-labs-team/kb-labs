/**
 * Tests for evaluateAuthReadiness.
 *
 * The state this exists to catch: auth enabled, no active tenant-admin —
 * login is impossible and every failure looks identical (CD-8). Each case
 * builds the real stores, so "active admin" means the same thing here as at
 * login time (membership AND active user in the right tenant).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDocumentDatabase } from '@kb-labs/sdk/testing';
import { UsersStore } from '../users-store.js';
import { CredentialsStore } from '../credentials-store.js';
import { MembershipsStore } from '../memberships-store.js';
import { ensureBootstrapAdmin } from '../bootstrap-admin.js';
import { evaluateAuthReadiness, type AuthReadinessInput } from '../auth-readiness.js';

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
    ...overrides,
  });

const seedAdmin = async (userId = 'u1', status: 'active' | 'disabled' = 'active', tenantId = TENANT) => {
  await users.create({ userId, tenantId, email: `${userId}@x.test`, status });
  await memberships.addMembership({ userId, tenantId, groupId: 'tenant-admin' });
};

describe('auth enabled', () => {
  it('is ok with one active admin and a real secret', async () => {
    await seedAdmin();
    const r = await evaluate();
    expect(r).toMatchObject({ ok: true, activeAdmins: 1, issues: [] });
  });

  it('empty database → no_active_admin error with a copy-pasteable fix', async () => {
    const r = await evaluate({ bootstrap: { status: 'not-configured', email: EMAIL } });

    expect(r.ok).toBe(false);
    expect(r.activeAdmins).toBe(0);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ code: 'no_active_admin', severity: 'error' });
    expect(r.issues[0]!.hint).toContain(`kb auth reset-admin --email ${EMAIL} --tenant ${TENANT}`);
  });

  it('falls back to a placeholder email in the hint when none is configured', async () => {
    const r = await evaluate({ bootstrap: { status: 'not-configured' } });
    expect(r.issues[0]!.hint).toContain('--email <admin-email>');
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

  it('default secret on loopback is only a warning (dev)', async () => {
    await seedAdmin();
    const r = await evaluate({ jwtSecretIsDefault: true, loopbackOnly: true });
    expect(r.ok).toBe(true);
    expect(r.issues[0]).toMatchObject({ code: 'jwt_secret_default', severity: 'warning' });
  });
});

describe('auth disabled (solo/local)', () => {
  it('never reports issues, even with no admin and a default secret', async () => {
    const r = await evaluate({ authEnabled: false, jwtSecretIsDefault: true, bootstrap: { status: 'not-configured' } });
    expect(r).toMatchObject({ ok: true, authEnabled: false, issues: [] });
  });
});

describe('the seeded-by-bootstrap path', () => {
  it('a bootstrap-provisioned admin makes a fresh install ready', async () => {
    const status = await ensureBootstrapAdmin({
      bootstrap: { adminEmail: EMAIL, adminPassword: 'long-enough-password', tenantId: TENANT },
      users, credentials, memberships, bcryptCost: 4, logger,
    });
    expect(status).toBe('provisioned');
    expect(await evaluate({ bootstrap: { status, email: EMAIL } })).toMatchObject({ ok: true, activeAdmins: 1 });
  });

  it('never leaks secret material in its output', async () => {
    const r = await evaluate({ jwtSecretIsDefault: true });
    expect(JSON.stringify(r)).not.toMatch(/dev-insecure-secret|password|hash/i);
  });
});
