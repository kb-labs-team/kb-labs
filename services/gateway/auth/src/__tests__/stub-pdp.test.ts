/**
 * Tests for the stub PDP (ADR-0020, Phase 1.12).
 *
 * Implements `IPolicyDecisionPoint` for this iteration. Two paths:
 *
 * - `check(identity, action)` applies the admin/member policy.
 *
 * - `enumeratePermissions(identity)` returns the subset of canonical
 *   permissions the identity currently has. Used by GET /auth/permissions
 *   to seed Studio's `useCan(...)` map (CD-3).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { createInMemoryDocumentDatabase } from '@kb-labs/sdk/testing';
import type { Identity } from '@kb-labs/core-contracts';
import { PERMISSIONS } from '@kb-labs/core-contracts';
import { MembershipsStore } from '../memberships-store.js';
import { createStubPDP } from '../stub-pdp.js';

let memberships: MembershipsStore;

beforeEach(() => {
  const docs = createInMemoryDocumentDatabase();
  memberships = new MembershipsStore(docs);
});

const userId = 'u1';
const tenantId = 't1';
const userIdentity: Identity = { userId, tenantId, type: 'user' };
const machineIdentity: Identity = { userId: 'm1', tenantId, type: 'machine' };

describe('check', () => {
  it('denies anonymous (no membership in tenant)', async () => {
    const pdp = createStubPDP({ memberships });
    const r = await pdp.check(userIdentity, PERMISSIONS.USERS_WRITE);
    expect(r).toEqual({ allow: false, reason: 'no_membership' });
  });

  it('denies tenant-member on admin-actions while allowing normal project use', async () => {
    await memberships.addMembership({ userId, tenantId, groupId: 'tenant-member' });
    const pdp = createStubPDP({ memberships });
    expect(await pdp.check(userIdentity, PERMISSIONS.USERS_WRITE))
      .toMatchObject({ allow: false });
    expect(await pdp.check(userIdentity, PERMISSIONS.PROJECTS_READ))
      .toEqual({ allow: true });
  });

  it('allows tenant-admin on admin-actions', async () => {
    await memberships.addMembership({ userId, tenantId, groupId: 'tenant-admin' });
    const pdp = createStubPDP({ memberships });
    expect(await pdp.check(userIdentity, PERMISSIONS.USERS_WRITE))
      .toEqual({ allow: true });
  });

  it('allows only machine registration for machine identities', async () => {
    const pdp = createStubPDP({ memberships });
    expect(await pdp.check(machineIdentity, PERMISSIONS.MACHINE_REGISTER))
      .toEqual({ allow: true });
    expect(await pdp.check(machineIdentity, PERMISSIONS.USERS_WRITE))
      .toMatchObject({ allow: false });
  });

  it('only consults membership in the identity\'s own tenant', async () => {
    // user is admin in t-other, member in t1
    await memberships.addMembership({ userId, tenantId: 't-other', groupId: 'tenant-admin' });
    await memberships.addMembership({ userId, tenantId, groupId: 'tenant-member' });
    const pdp = createStubPDP({ memberships });
    expect(await pdp.check(userIdentity, PERMISSIONS.USERS_WRITE))
      .toMatchObject({ allow: false });
  });

  it('denies unknown action even for tenant-admin (closed-world)', async () => {
    await memberships.addMembership({ userId, tenantId, groupId: 'tenant-admin' });
    const pdp = createStubPDP({ memberships });
    expect(await pdp.check(userIdentity, 'unknown:action'))
      .toMatchObject({ allow: false });
  });
});

describe('enumeratePermissions', () => {
  it('returns [] for anonymous (no membership)', async () => {
    const pdp = createStubPDP({ memberships });
    expect(await pdp.enumeratePermissions(userIdentity)).toEqual([]);
  });

  it('returns only project, plugin, workflow, and own-account permissions for tenant-member', async () => {
    await memberships.addMembership({ userId, tenantId, groupId: 'tenant-member' });
    const pdp = createStubPDP({ memberships });
    expect(await pdp.enumeratePermissions(userIdentity)).toEqual([
      PERMISSIONS.PROJECTS_READ, PERMISSIONS.PROJECTS_WRITE,
      PERMISSIONS.PLUGINS_READ, PERMISSIONS.PLUGINS_WRITE,
      PERMISSIONS.WORKFLOWS_READ, PERMISSIONS.WORKFLOWS_WRITE,
      PERMISSIONS.ACCOUNT_READ, PERMISSIONS.ACCOUNT_WRITE,
    ]);
    expect((await pdp.check(userIdentity, PERMISSIONS.PLATFORM_SETTINGS_WRITE)).allow).toBe(false);
  });

  it('returns the full canonical set for tenant-admin', async () => {
    await memberships.addMembership({ userId, tenantId, groupId: 'tenant-admin' });
    const pdp = createStubPDP({ memberships });
    const got = await pdp.enumeratePermissions(userIdentity);
    expect(got.sort()).toEqual(Object.values(PERMISSIONS).sort());
  });

  it('returns the machine-only subset for machine identities', async () => {
    const pdp = createStubPDP({ memberships });
    const got = await pdp.enumeratePermissions(machineIdentity);
    expect(got).toEqual([PERMISSIONS.MACHINE_REGISTER]);
  });
});
