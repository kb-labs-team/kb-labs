/**
 * Tests for the user-auth orchestration service (ADR-0020, Phase 1.15).
 *
 * Pulls together every store + provider + jwt + policy + password-policy
 * into the five operations the HTTP layer calls:
 *
 * - `login(providerInput, tenantId, deviceCtx)`
 * - `refresh(refreshToken)`
 * - `logout(refreshToken)`
 * - `changePassword(userId, currentFamilyId, current, next)`
 * - `activate(plainToken, password, deviceCtx)`
 *
 * Coverage focuses on the contract boundary: every not-ok user-facing
 * response collapses to a single opaque error code (CD-8); refresh
 * inherits reuse-detection + grace from the sessions-store; CD-1
 * (disabled user mid-session) is enforced here on the refresh path;
 * changePassword keeps the caller's family alive.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { createInMemoryDocumentDatabase } from '@kb-labs/sdk/testing';
import type { IDocumentDatabase } from '@kb-labs/core-platform/adapters';
import { UsersStore } from '../users-store.js';
import { CredentialsStore } from '../credentials-store.js';
import { MembershipsStore } from '../memberships-store.js';
import { InvitesStore } from '../invites-store.js';
import { SessionsStore } from '../sessions-store.js';
import { ProviderRegistry } from '../provider-registry.js';
import { createEmailPasswordProvider } from '../providers/email-password.js';
import { createPasswordPolicy } from '../password-policy.js';
import { createUserAuthService, AuthError } from '../user-auth-service.js';
import { verifyUserRefreshToken } from '../jwt.js';

const HOUR = 60 * 60 * 1000;
const tenant = 'kblabs-cloud';
const jwtConfig = { secret: 'test-secret-at-least-32-chars-long!!' };

let docs: IDocumentDatabase;
let users: UsersStore;
let credentials: CredentialsStore;
let memberships: MembershipsStore;
let invites: InvitesStore;
let sessions: SessionsStore;
let svc: ReturnType<typeof createUserAuthService>;
let nowMs: number;

beforeEach(() => {
  nowMs = 1_000_000_000_000;
  docs = createInMemoryDocumentDatabase();
  users = new UsersStore(docs);
  credentials = new CredentialsStore(docs);
  memberships = new MembershipsStore(docs);
  invites = new InvitesStore(docs, () => nowMs);
  sessions = new SessionsStore(docs, { now: () => nowMs, refreshTtlMs: HOUR, graceWindowMs: 5_000 });

  const registry = new ProviderRegistry();
  registry.register(
    createEmailPasswordProvider({ users, credentials, tenantId: tenant, bcryptCost: 4 }),
  );

  svc = createUserAuthService({
    users,
    credentials,
    memberships,
    invites,
    sessions,
    providers: registry,
    passwordPolicy: createPasswordPolicy({ minLength: 8, maxLength: 256, hibpEnabled: false }),
    jwtConfig,
    accessTtlSec: 900,
    refreshTtlSec: 3600,
    bcryptCost: 4,
    now: () => nowMs,
  });
});

const seedActiveUser = async (
  email = 'alice@x.com',
  pw = 'correct-pw-12',
  group: 'tenant-admin' | 'tenant-member' = 'tenant-admin',
) => {
  const userId = `u-${email}`;
  await users.create({ userId, tenantId: tenant, email, status: 'active' });
  await credentials.setCredential({
    userId, providerId: 'email-password', hash: await bcrypt.hash(pw, 4),
  });
  await memberships.addMembership({ userId, tenantId: tenant, groupId: group });
  return userId;
};

// ─── login ──────────────────────────────────────────────────────────────

describe('login', () => {
  it('happy path issues access + refresh + csrf and creates a session', async () => {
    const userId = await seedActiveUser();
    const r = await svc.login(
      { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
      tenant,
      { userAgent: 'TestUA', ip: '1.2.3.4' },
    );
    expect(r.user).toMatchObject({ userId, email: 'alice@x.com', tenantId: tenant });
    expect(r.access.token).toBeTypeOf('string');
    expect(r.refresh.token).toBeTypeOf('string');
    expect(r.csrf).toBeTypeOf('string');
    expect(await sessions.listFamiliesByUser(userId)).toHaveLength(1);
  });

  it('collapses every failure to AuthError("invalid_credentials") (CD-8)', async () => {
    await expect(
      svc.login(
        { providerId: 'email-password', input: { email: 'nobody@x.com', password: 'whatever' } },
        tenant,
        {},
      ),
    ).rejects.toMatchObject({ name: 'AuthError', code: 'invalid_credentials' });

    const userId = await seedActiveUser();
    await users.setStatus(userId, 'disabled');
    await expect(
      svc.login(
        { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
        tenant,
        {},
      ),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('throws unknown_provider for an unregistered providerId', async () => {
    await expect(
      svc.login({ providerId: 'google', input: {} }, tenant, {}),
    ).rejects.toMatchObject({ code: 'unknown_provider' });
  });

  it('records device context (userAgent + ip) on the session family', async () => {
    const userId = await seedActiveUser();
    await svc.login(
      { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
      tenant,
      { userAgent: 'TestUA', ip: '9.9.9.9' },
    );
    const fams = await sessions.listFamiliesByUser(userId);
    expect(fams[0]).toMatchObject({ userAgent: 'TestUA', ipFirst: '9.9.9.9' });
  });
});

// ─── refresh ────────────────────────────────────────────────────────────

describe('refresh', () => {
  it('happy path rotates tokens', async () => {
    await seedActiveUser();
    const loggedIn = await svc.login(
      { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
      tenant, {},
    );
    nowMs += 1_000;
    const r = await svc.refresh(loggedIn.refresh.token);
    expect(r.access.token).toBeTypeOf('string');
    expect(r.refresh.token).toBeTypeOf('string');
    expect(r.refresh.token).not.toBe(loggedIn.refresh.token);
  });

  it('throws invalid_refresh for a bogus refresh JWT', async () => {
    await expect(svc.refresh('not-a-jwt')).rejects.toMatchObject({ code: 'invalid_refresh' });
  });

  it('rejects an access token presented as a refresh', async () => {
    await seedActiveUser();
    const loggedIn = await svc.login(
      { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
      tenant, {},
    );
    await expect(svc.refresh(loggedIn.access.token)).rejects.toMatchObject({ code: 'invalid_refresh' });
  });

  it('CD-1: refresh by a disabled user fails AND revokes the family', async () => {
    const userId = await seedActiveUser();
    const loggedIn = await svc.login(
      { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
      tenant, {},
    );
    await users.setStatus(userId, 'disabled');
    nowMs += 1_000;
    await expect(svc.refresh(loggedIn.refresh.token)).rejects.toMatchObject({ code: 'user_disabled' });
    expect(await sessions.listFamiliesByUser(userId)).toHaveLength(0);
  });

  it('past-grace reuse throws refresh_reuse and the family is dead', async () => {
    const userId = await seedActiveUser();
    const loggedIn = await svc.login(
      { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
      tenant, {},
    );
    await svc.refresh(loggedIn.refresh.token);
    nowMs += 10_000;
    await expect(svc.refresh(loggedIn.refresh.token)).rejects.toMatchObject({ code: 'refresh_reuse' });
    expect(await sessions.listFamiliesByUser(userId)).toHaveLength(0);
  });

  it('grace-window retry succeeds and keeps the family alive', async () => {
    const userId = await seedActiveUser();
    const loggedIn = await svc.login(
      { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
      tenant, {},
    );
    const first = await svc.refresh(loggedIn.refresh.token);
    nowMs += 2_000; // still in 5s grace
    const second = await svc.refresh(loggedIn.refresh.token);
    // Same replacement on both calls — single new refresh issued. Identity is
    // the jti, NOT the JWT string: the token is re-signed on every call with
    // the wall-clock `iat` (jose reads Date.now, not the injected `now`), so
    // the strings differ whenever a real second boundary falls in between.
    const a = await verifyUserRefreshToken(first.refresh.token, jwtConfig);
    const b = await verifyUserRefreshToken(second.refresh.token, jwtConfig);
    expect(a).not.toBeNull();
    expect(b?.jti).toBe(a?.jti);
    expect(b?.familyId).toBe(a?.familyId);
    expect(await sessions.listFamiliesByUser(userId)).toHaveLength(1);
  });

  describe('grace retry across a wall-clock second boundary', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('re-signs the same replacement jti with a different JWT string (iat moved), family stays alive', async () => {
      const userId = await seedActiveUser();
      const loggedIn = await svc.login(
        { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
        tenant, {},
      );
      // Pin the real clock 1ms before a second boundary (this is the timing
      // that made the string-equality assertion flaky in CI).
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_700_000_000_999);
      const first = await svc.refresh(loggedIn.refresh.token);
      vi.setSystemTime(1_700_000_001_001);
      nowMs += 2_000; // still in 5s grace by the injected clock
      const second = await svc.refresh(loggedIn.refresh.token);

      expect(second.refresh.token).not.toBe(first.refresh.token); // iat differs
      const a = await verifyUserRefreshToken(first.refresh.token, jwtConfig);
      const b = await verifyUserRefreshToken(second.refresh.token, jwtConfig);
      expect(b?.jti).toBe(a?.jti);
      expect(await sessions.listFamiliesByUser(userId)).toHaveLength(1);
    });
  });
});

// ─── logout ─────────────────────────────────────────────────────────────

describe('logout', () => {
  it('revokes the family of the presented refresh', async () => {
    const userId = await seedActiveUser();
    const loggedIn = await svc.login(
      { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
      tenant, {},
    );
    await svc.logout(loggedIn.refresh.token);
    expect(await sessions.listFamiliesByUser(userId)).toHaveLength(0);
  });

  it('is idempotent (already-logged-out / unknown token)', async () => {
    await expect(svc.logout('garbage')).resolves.not.toThrow();
  });
});

// ─── changePassword ────────────────────────────────────────────────────

describe('changePassword', () => {
  it('happy: rewrites credential, kills other families, keeps current alive', async () => {
    const userId = await seedActiveUser();
    const sessA = await svc.login(
      { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
      tenant, { userAgent: 'A' },
    );
    const sessB = await svc.login(
      { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
      tenant, { userAgent: 'B' },
    );

    await svc.changePassword({
      userId,
      currentFamilyId: sessA.familyId,
      currentPassword: 'correct-pw-12',
      newPassword: 'brand-new-pw-99',
    });

    // sessA still alive, sessB dead.
    const fams = await sessions.listFamiliesByUser(userId);
    expect(fams).toHaveLength(1);
    expect(fams[0]?.familyId).toBe(sessA.familyId);

    // Old password no longer works; new one does.
    await expect(
      svc.login({ providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } }, tenant, {}),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });

    const reLogin = await svc.login(
      { providerId: 'email-password', input: { email: 'alice@x.com', password: 'brand-new-pw-99' } },
      tenant, {},
    );
    expect(reLogin.user.userId).toBe(userId);

    // The dead family's refresh cannot be used to authenticate.
    await expect(svc.refresh(sessB.refresh.token)).rejects.toMatchObject({ code: 'invalid_refresh' });
  });

  it('wrong current password → invalid_current_password and no state change', async () => {
    const userId = await seedActiveUser();
    const sess = await svc.login(
      { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
      tenant, {},
    );
    await expect(svc.changePassword({
      userId, currentFamilyId: sess.familyId,
      currentPassword: 'WRONG', newPassword: 'brand-new-pw-99',
    })).rejects.toMatchObject({ code: 'invalid_current_password' });

    // Original password still works.
    await svc.login(
      { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
      tenant, {},
    );
  });

  it('weak new password → weak_password with structured reason', async () => {
    const userId = await seedActiveUser();
    const sess = await svc.login(
      { providerId: 'email-password', input: { email: 'alice@x.com', password: 'correct-pw-12' } },
      tenant, {},
    );
    await expect(svc.changePassword({
      userId, currentFamilyId: sess.familyId,
      currentPassword: 'correct-pw-12', newPassword: 'short',
    })).rejects.toMatchObject({ code: 'weak_password', reason: 'too_short' });
  });
});

// ─── activate ──────────────────────────────────────────────────────────

describe('activate', () => {
  it('happy: creates user, credential, membership, consumes invite, auto-logs in', async () => {
    // admin issues invite
    const { activationToken } = await invites.createInvite({
      email: 'bob@x.com', tenantId: tenant,
      groupId: 'tenant-member', createdBy: 'admin', ttlMs: HOUR,
    });

    const r = await svc.activate({
      activationToken,
      password: 'fresh-pw-1234',
      deviceCtx: { userAgent: 'IE5' },
    });

    expect(r.user.email).toBe('bob@x.com');
    expect(r.user.tenantId).toBe(tenant);
    expect(r.access.token).toBeTypeOf('string');
    expect(r.refresh.token).toBeTypeOf('string');

    // User is active.
    const u = await users.findByEmailTenant('bob@x.com', tenant);
    expect(u!.status).toBe('active');
    // Membership matches the invite.
    const m = await memberships.listByUser(u!.userId);
    expect(m[0]?.groupId).toBe('tenant-member');
    // Token cannot be reused.
    const second = await invites.findByToken(activationToken);
    expect(second.kind).toBe('invalid');
  });

  it('unknown token → unknown_invite, no side-effects', async () => {
    await expect(svc.activate({
      activationToken: 'definitely-not-real', password: 'fresh-pw-1234', deviceCtx: {},
    })).rejects.toMatchObject({ code: 'unknown_invite' });
  });

  it('expired invite → invalid_invite', async () => {
    const { activationToken } = await invites.createInvite({
      email: 'bob@x.com', tenantId: tenant,
      groupId: 'tenant-member', createdBy: 'admin', ttlMs: 1,
    });
    nowMs += 10;
    await expect(svc.activate({
      activationToken, password: 'fresh-pw-1234', deviceCtx: {},
    })).rejects.toMatchObject({ code: 'invalid_invite' });
  });

  it('weak password → weak_password and invite stays usable', async () => {
    const { activationToken } = await invites.createInvite({
      email: 'bob@x.com', tenantId: tenant,
      groupId: 'tenant-member', createdBy: 'admin', ttlMs: HOUR,
    });
    await expect(svc.activate({
      activationToken, password: 'short', deviceCtx: {},
    })).rejects.toMatchObject({ code: 'weak_password' });

    // Invite still active so the user can retry with a proper password.
    expect((await invites.findByToken(activationToken)).kind).toBe('ok');
  });

  it('two parallel activations of the same token → exactly one account, one winner (TOCTOU)', async () => {
    const { activationToken } = await invites.createInvite({
      email: 'race@x.com', tenantId: tenant,
      groupId: 'tenant-member', createdBy: 'admin', ttlMs: HOUR,
    });

    // Fire both with the identical valid token + password concurrently.
    // The atomic consume() gate must let exactly one through to account
    // creation; the loser must reject cleanly (invalid_invite) WITHOUT
    // creating a second user or crashing on the unique-email index.
    const settled = await Promise.allSettled([
      svc.activate({ activationToken, password: 'fresh-pw-1234', deviceCtx: {} }),
      svc.activate({ activationToken, password: 'fresh-pw-1234', deviceCtx: {} }),
    ]);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'invalid_invite' });

    // Exactly one user account exists for that email in the tenant.
    const all = await users.listByTenant(tenant);
    expect(all.filter((u) => u.email === 'race@x.com')).toHaveLength(1);
  });
});

// ─── AuthError shape ───────────────────────────────────────────────────

describe('AuthError', () => {
  it('exposes a code and is an Error instance', () => {
    const e = new AuthError('invalid_credentials');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('AuthError');
    expect(e.code).toBe('invalid_credentials');
  });
});
