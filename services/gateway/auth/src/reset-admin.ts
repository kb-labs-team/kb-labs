/**
 * @module @kb-labs/gateway-auth/reset-admin
 *
 * Operator-driven recovery of the tenant admin account (ADR-0020).
 *
 * `ensureBootstrapAdmin` is deliberately conservative: it never touches an
 * existing user, so it cannot repair an admin whose credential was lost, whose
 * status was flipped to `disabled`, or whose membership disappeared. There is
 * no email-based reset either (ADR-0020, "What we are NOT doing"). `resetAdmin`
 * is the explicit, operator-invoked counterpart: it runs against the document
 * database directly (no HTTP, no running gateway) and brings the account to a
 * known-good state:
 *
 * - user exists and is `active` (created when missing),
 * - `email-password` credential holds the new password hash,
 * - membership in the tenant is `tenant-admin`,
 * - every existing session of the user is revoked.
 *
 * The password is validated against the same policy as activation and change,
 * before anything is written, so a rejected password leaves the account intact.
 */

import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { UsersStore } from './users-store.js';
import { canonicalizeEmail } from './users-store.js';
import type { CredentialsStore } from './credentials-store.js';
import type { MembershipsStore } from './memberships-store.js';
import type { SessionsStore } from './sessions-store.js';
import type { PasswordPolicy } from './password-policy.js';

export interface ResetAdminLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface ResetAdminOptions {
  users: UsersStore;
  credentials: CredentialsStore;
  memberships: MembershipsStore;
  sessions: SessionsStore;
  passwordPolicy: PasswordPolicy;
  bcryptCost: number;
  tenantId: string;
  email: string;
  password: string;
  logger: ResetAdminLogger;
}

export type ResetAdminRepair =
  | 'user-created'
  | 'user-reactivated'
  | 'credential-set'
  | 'membership-created'
  | 'membership-promoted';

export interface ResetAdminResult {
  userId: string;
  tenantId: string;
  email: string;
  /** `created` when no user existed; `reset` when an existing account was repaired. */
  outcome: 'created' | 'reset';
  /** What was actually changed, for the operator's report. */
  repairs: ResetAdminRepair[];
}

export class ResetAdminError extends Error {
  constructor(
    readonly code: 'weak_password' | 'invalid_input',
    message: string,
  ) {
    super(message);
    this.name = 'ResetAdminError';
  }
}

export const resetAdmin = async (opts: ResetAdminOptions): Promise<ResetAdminResult> => {
  const { users, credentials, memberships, sessions, tenantId, logger } = opts;
  const email = canonicalizeEmail(opts.email);

  if (!email || !tenantId) {
    throw new ResetAdminError('invalid_input', 'resetAdmin: email and tenantId are required');
  }

  const policy = await opts.passwordPolicy.validate(opts.password);
  if (!policy.ok) {
    throw new ResetAdminError('weak_password', `password rejected by policy: ${policy.reason}`);
  }

  const repairs: ResetAdminRepair[] = [];
  const existing = await users.findByEmailTenant(email, tenantId);

  let userId: string;
  if (!existing) {
    userId = randomUUID();
    await users.create({ userId, tenantId, email, status: 'active' });
    repairs.push('user-created');
  } else {
    userId = existing.userId;
    if (existing.status !== 'active') {
      await users.setStatus(userId, 'active');
      repairs.push('user-reactivated');
    }
  }

  const hash = await bcrypt.hash(opts.password, opts.bcryptCost);
  await credentials.setCredential({ userId, providerId: 'email-password', hash });
  repairs.push('credential-set');

  const membership = (await memberships.listByUser(userId)).find((m) => m.tenantId === tenantId);
  if (!membership) {
    await memberships.addMembership({ userId, tenantId, groupId: 'tenant-admin' });
    repairs.push('membership-created');
  } else if (membership.groupId !== 'tenant-admin') {
    await memberships.setGroup(userId, tenantId, 'tenant-admin');
    repairs.push('membership-promoted');
  }

  // A reset is often a response to a suspected compromise — no old session may survive it.
  await sessions.revokeAllUserSessions(userId);

  const outcome = existing ? 'reset' : 'created';
  logger.info('reset-admin: admin account restored', { userId, tenantId, outcome, repairs });
  return { userId, tenantId, email, outcome, repairs };
};
