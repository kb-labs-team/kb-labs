/**
 * Tests for bootstrap-admin (ADR-0020, Phase 1.14).
 *
 * On the very first start of a fresh deployment, gateway provisions a
 * tenant-admin user from env / config so the operator can actually log
 * in and invite their team.
 *
 * Invariants:
 * - Idempotent. Running `ensureBootstrapAdmin` three times against the
 *   same DB must leave one User, one Credential, one Membership.
 * - No-op when bootstrap config is absent.
 * - No-op (with a logged warning) when a User already exists with that
 *   `(email, tenantId)` but a different status. We never silently
 *   re-activate or re-password an existing account.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { createInMemoryDocumentDatabase } from '@kb-labs/sdk/testing';
import { UsersStore } from '../users-store.js';
import { CredentialsStore } from '../credentials-store.js';
import { MembershipsStore } from '../memberships-store.js';
import { ensureBootstrapAdmin } from '../bootstrap-admin.js';

let users: UsersStore;
let credentials: CredentialsStore;
let memberships: MembershipsStore;
let warnings: unknown[];

beforeEach(() => {
  const docs = createInMemoryDocumentDatabase();
  users = new UsersStore(docs);
  credentials = new CredentialsStore(docs);
  memberships = new MembershipsStore(docs);
  warnings = [];
});

const logger = {
  warn: (...args: unknown[]) => warnings.push(args),
  info: () => undefined,
  error: () => undefined,
};

const cfg = {
  adminEmail: 'admin@kblabs.ru',
  adminPassword: 'super-long-bootstrap-pw',
  tenantId: 'kblabs-cloud',
};

describe('happy path', () => {
  it('creates user(active) + credential + membership(tenant-admin) on first call', async () => {
    await ensureBootstrapAdmin({
      bootstrap: cfg,
      users,
      credentials,
      memberships,
      bcryptCost: 4,
      logger,
    });
    const u = await users.findByEmailTenant(cfg.adminEmail, cfg.tenantId);
    expect(u).not.toBeNull();
    expect(u!.status).toBe('active');

    const cred = await credentials.getCredential(u!.userId, 'email-password');
    expect(cred).not.toBeNull();
    // Stored hash verifies the input password (so we know the cost was
    // applied correctly and we are not storing plaintext).
    const ok = await bcrypt.compare(cfg.adminPassword, cred!.hash);
    expect(ok).toBe(true);

    const mem = await memberships.listByUser(u!.userId);
    expect(mem).toHaveLength(1);
    expect(mem[0]).toMatchObject({ tenantId: cfg.tenantId, groupId: 'tenant-admin' });
  });
});

describe('idempotency', () => {
  it('three consecutive runs yield exactly one admin', async () => {
    for (let i = 0; i < 3; i++) {
      await ensureBootstrapAdmin({ bootstrap: cfg, users, credentials, memberships, bcryptCost: 4, logger });
    }
    const u = await users.findByEmailTenant(cfg.adminEmail, cfg.tenantId);
    expect(u).not.toBeNull();
    const allMem = await memberships.listByUser(u!.userId);
    expect(allMem).toHaveLength(1);
    expect(warnings.length).toBe(0); // no warnings on idempotent reruns
  });
});

describe('absent bootstrap config', () => {
  it('is a no-op when bootstrap is undefined', async () => {
    await ensureBootstrapAdmin({
      bootstrap: undefined,
      users, credentials, memberships, bcryptCost: 4, logger,
    });
    expect(await users.findByEmailTenant(cfg.adminEmail, cfg.tenantId)).toBeNull();
  });

  it('throws on partial bootstrap (missing email / password / tenant)', async () => {
    await expect(
      ensureBootstrapAdmin({
        bootstrap: { adminEmail: cfg.adminEmail, adminPassword: '', tenantId: cfg.tenantId },
        users, credentials, memberships, bcryptCost: 4, logger,
      }),
    ).rejects.toThrow();
  });
});

describe('conflicting state', () => {
  it('logs a warning and does not touch a pre-existing user with another status', async () => {
    // Operator created an account manually with status: disabled and re-set the env.
    await users.create({
      userId: 'pre-existing',
      tenantId: cfg.tenantId,
      email: cfg.adminEmail,
      status: 'disabled',
    });
    await ensureBootstrapAdmin({ bootstrap: cfg, users, credentials, memberships, bcryptCost: 4, logger });
    const u = await users.findByEmailTenant(cfg.adminEmail, cfg.tenantId);
    expect(u!.userId).toBe('pre-existing');
    expect(u!.status).toBe('disabled');
    expect(warnings.length).toBeGreaterThan(0);
    // No credential was set.
    expect(await credentials.getCredential('pre-existing', 'email-password')).toBeNull();
  });
});

describe('returned outcome', () => {
  const run = (bootstrap: typeof cfg | undefined) =>
    ensureBootstrapAdmin({ bootstrap, users, credentials, memberships, bcryptCost: 4, logger });

  it("'not-configured' when there is no bootstrap config", async () => {
    expect(await run(undefined)).toBe('not-configured');
  });

  it("'provisioned' on first run, then 'exists-active'", async () => {
    expect(await run(cfg)).toBe('provisioned');
    expect(await run(cfg)).toBe('exists-active');
  });

  it("'exists-non-active' when the existing admin is disabled", async () => {
    await run(cfg);
    const user = await users.findByEmailTenant(cfg.adminEmail, cfg.tenantId);
    await users.setStatus(user!.userId, 'disabled');
    expect(await run(cfg)).toBe('exists-non-active');
  });
});
