/**
 * Tests for resetAdmin (ADR-0020 operator recovery).
 *
 * `ensureBootstrapAdmin` never touches an existing user, so it cannot repair a
 * broken admin. `resetAdmin` is the explicit recovery path; these tests pin
 * every state the admin account can be stranded in, and that a successful
 * reset really lets the admin log in through the real email-password provider.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDocumentDatabase } from '@kb-labs/sdk/testing';
import { UsersStore } from '../users-store.js';
import { CredentialsStore } from '../credentials-store.js';
import { MembershipsStore } from '../memberships-store.js';
import { SessionsStore } from '../sessions-store.js';
import { createPasswordPolicy } from '../password-policy.js';
import { createEmailPasswordProvider } from '../providers/email-password.js';
import { ensureBootstrapAdmin } from '../bootstrap-admin.js';
import { resetAdmin, ResetAdminError } from '../reset-admin.js';

const TENANT = 'kblabs-cloud';
const EMAIL = 'admin@kblabs.ru';
const OLD_PASSWORD = 'old-bootstrap-password-1';
const NEW_PASSWORD = 'brand-new-admin-password-2';

let users: UsersStore;
let credentials: CredentialsStore;
let memberships: MembershipsStore;
let sessions: SessionsStore;

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const passwordPolicy = createPasswordPolicy({ minLength: 8, maxLength: 256, hibpEnabled: false });

const reset = (overrides: Partial<Parameters<typeof resetAdmin>[0]> = {}) =>
  resetAdmin({
    users,
    credentials,
    memberships,
    sessions,
    passwordPolicy,
    bcryptCost: 4,
    tenantId: TENANT,
    email: EMAIL,
    password: NEW_PASSWORD,
    logger,
    ...overrides,
  });

const canLogin = async (password: string): Promise<boolean> => {
  const provider = createEmailPasswordProvider({ users, credentials, tenantId: TENANT, bcryptCost: 4 });
  const result = await provider.authenticate({ email: EMAIL, password });
  return result.ok;
};

const seedBootstrapAdmin = async (): Promise<string> => {
  await ensureBootstrapAdmin({
    bootstrap: { adminEmail: EMAIL, adminPassword: OLD_PASSWORD, tenantId: TENANT },
    users,
    credentials,
    memberships,
    bcryptCost: 4,
    logger,
  });
  const user = await users.findByEmailTenant(EMAIL, TENANT);
  return user!.userId;
};

beforeEach(() => {
  const docs = createInMemoryDocumentDatabase();
  users = new UsersStore(docs);
  credentials = new CredentialsStore(docs);
  memberships = new MembershipsStore(docs);
  sessions = new SessionsStore(docs, { refreshTtlMs: 60_000, graceWindowMs: 0 });
});

describe('admin does not exist', () => {
  it('creates an active user, credential and tenant-admin membership', async () => {
    const result = await reset();

    expect(result.outcome).toBe('created');
    expect(result.repairs).toEqual(['user-created', 'credential-set', 'membership-created']);
    const user = await users.findByEmailTenant(EMAIL, TENANT);
    expect(user?.status).toBe('active');
    expect((await memberships.listByUser(result.userId))[0]?.groupId).toBe('tenant-admin');
    expect(await canLogin(NEW_PASSWORD)).toBe(true);
  });
});

describe('admin stranded in a broken state', () => {
  it('credential deleted while user is active — the case the old docs recipe created', async () => {
    const userId = await seedBootstrapAdmin();
    await credentials.deleteCredential(userId, 'email-password');
    expect(await canLogin(OLD_PASSWORD)).toBe(false);

    // Re-running the bootstrap does NOT repair it: it skips an active user.
    await ensureBootstrapAdmin({
      bootstrap: { adminEmail: EMAIL, adminPassword: OLD_PASSWORD, tenantId: TENANT },
      users, credentials, memberships, bcryptCost: 4, logger,
    });
    expect(await canLogin(OLD_PASSWORD)).toBe(false);

    const result = await reset();

    expect(result.outcome).toBe('reset');
    expect(result.userId).toBe(userId);
    expect(result.repairs).toEqual(['credential-set']);
    expect(await canLogin(NEW_PASSWORD)).toBe(true);
  });

  it('forgotten password — old one stops working, new one works', async () => {
    await seedBootstrapAdmin();
    expect(await canLogin(OLD_PASSWORD)).toBe(true);

    await reset();

    expect(await canLogin(OLD_PASSWORD)).toBe(false);
    expect(await canLogin(NEW_PASSWORD)).toBe(true);
  });

  it('user disabled — reactivates', async () => {
    const userId = await seedBootstrapAdmin();
    await users.setStatus(userId, 'disabled');
    expect(await canLogin(OLD_PASSWORD)).toBe(false);

    const result = await reset();

    expect(result.repairs).toContain('user-reactivated');
    expect((await users.getById(userId))?.status).toBe('active');
    expect(await canLogin(NEW_PASSWORD)).toBe(true);
  });

  it('membership missing — recreated as tenant-admin', async () => {
    const userId = await seedBootstrapAdmin();
    await memberships.removeMembership(userId, TENANT);

    const result = await reset();

    expect(result.repairs).toContain('membership-created');
    expect((await memberships.listByUser(userId))[0]?.groupId).toBe('tenant-admin');
  });

  it('membership demoted to tenant-member — promoted back', async () => {
    const userId = await seedBootstrapAdmin();
    await memberships.setGroup(userId, TENANT, 'tenant-member');

    const result = await reset();

    expect(result.repairs).toContain('membership-promoted');
    expect((await memberships.listByUser(userId))[0]?.groupId).toBe('tenant-admin');
  });

  it('email casing and whitespace are canonicalised', async () => {
    const userId = await seedBootstrapAdmin();

    const result = await reset({ email: `  ${EMAIL.toUpperCase()} ` });

    expect(result.userId).toBe(userId);
    expect(result.outcome).toBe('reset');
  });
});

describe('sessions', () => {
  it('revokes every existing session of the admin, leaves other users alone', async () => {
    const userId = await seedBootstrapAdmin();
    const adminSession = await sessions.createSession({ userId, tenantId: TENANT, deviceCtx: {} });
    const other = await sessions.createSession({ userId: 'someone-else', tenantId: TENANT, deviceCtx: {} });

    await reset();

    expect(await sessions.listFamiliesByUser(userId)).toHaveLength(0);
    await expect(sessions.rotateRefresh(adminSession.refreshJti)).rejects.toThrow();
    expect(await sessions.listFamiliesByUser('someone-else')).toHaveLength(1);
    expect(other.familyId).toBeTruthy();
  });
});

describe('password policy', () => {
  it('rejects a weak password and leaves the existing account untouched', async () => {
    const userId = await seedBootstrapAdmin();

    await expect(reset({ password: 'short' })).rejects.toMatchObject({
      name: 'ResetAdminError',
      code: 'weak_password',
    });

    expect(await canLogin(OLD_PASSWORD)).toBe(true);
    expect((await users.getById(userId))?.status).toBe('active');
  });

  it('a rejected password does not create a user when none existed', async () => {
    await expect(reset({ password: 'short' })).rejects.toBeInstanceOf(ResetAdminError);
    expect(await users.findByEmailTenant(EMAIL, TENANT)).toBeNull();
  });
});

describe('idempotence and isolation', () => {
  it('running twice leaves exactly one user, credential and membership', async () => {
    await reset();
    const second = await reset({ password: 'second-admin-password-3' });

    expect(second.outcome).toBe('reset');
    expect(await users.listByTenant(TENANT)).toHaveLength(1);
    expect(await memberships.listByTenant(TENANT)).toHaveLength(1);
    expect(await canLogin('second-admin-password-3')).toBe(true);
    expect(await canLogin(NEW_PASSWORD)).toBe(false);
  });

  it('does not touch the same email in another tenant', async () => {
    const otherTenant = 'other-tenant';
    const otherId = 'other-user-id';
    await users.create({ userId: otherId, tenantId: otherTenant, email: EMAIL, status: 'disabled' });

    await reset();

    expect((await users.getById(otherId))?.status).toBe('disabled');
    expect(await credentials.getCredential(otherId, 'email-password')).toBeNull();
  });

  it('rejects empty email or tenant', async () => {
    await expect(reset({ email: '  ' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(reset({ tenantId: '' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
