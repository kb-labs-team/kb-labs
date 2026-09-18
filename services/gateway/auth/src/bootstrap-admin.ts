/**
 * @module @kb-labs/gateway-auth/bootstrap-admin
 *
 * First-run admin provisioning (ADR-0020, Phase 1.14).
 *
 * On a fresh deployment the operator can't log in unless someone has
 * already been provisioned — and we deliberately removed the public
 * `/auth/register` for humans. `ensureBootstrapAdmin` reads bootstrap
 * config from env and creates a single tenant-admin User on first
 * start. Idempotent: subsequent runs see the existing User and do
 * nothing.
 *
 * Conflict handling is conservative: if a User with the configured
 * email already exists in the configured tenant but in a different
 * status (e.g. someone manually `disabled` them and forgot the env
 * was still set), we log a warning and **do not touch** the existing
 * record. Silently re-activating or re-passwording is the kind of
 * surprise we want to avoid on a production system.
 */

import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { UsersStore } from './users-store.js';
import type { CredentialsStore } from './credentials-store.js';
import type { MembershipsStore } from './memberships-store.js';

export interface BootstrapConfig {
  adminEmail: string;
  adminPassword: string;
  tenantId: string;
}

export interface BootstrapAdminLogger {
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface EnsureBootstrapAdminOptions {
  bootstrap: BootstrapConfig | undefined;
  users: UsersStore;
  credentials: CredentialsStore;
  memberships: MembershipsStore;
  bcryptCost: number;
  logger: BootstrapAdminLogger;
}

/**
 * What `ensureBootstrapAdmin` did, so the caller can report it (auth
 * readiness, startup diagnostics) without re-deriving it from the stores.
 */
export type BootstrapOutcome =
  | 'not-configured'
  | 'provisioned'
  | 'exists-active'
  | 'exists-non-active';

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export const ensureBootstrapAdmin = async (
  opts: EnsureBootstrapAdminOptions,
): Promise<BootstrapOutcome> => {
  const { bootstrap, users, credentials, memberships, bcryptCost, logger } = opts;

  if (!bootstrap) {
    logger.info('bootstrap-admin: no bootstrap config provided, skipping');
    return 'not-configured';
  }

  if (
    !isNonEmptyString(bootstrap.adminEmail) ||
    !isNonEmptyString(bootstrap.adminPassword) ||
    !isNonEmptyString(bootstrap.tenantId)
  ) {
    throw new Error(
      'bootstrap-admin: incomplete bootstrap config (need adminEmail, adminPassword, tenantId)',
    );
  }

  const existing = await users.findByEmailTenant(bootstrap.adminEmail, bootstrap.tenantId);

  if (existing) {
    if (existing.status === 'active') {
      logger.info('bootstrap-admin: admin already exists and is active, skipping');
      return 'exists-active';
    }
    logger.warn(
      'bootstrap-admin: a user with the bootstrap email already exists in a non-active state; not touching it',
      { userId: existing.userId, status: existing.status, tenantId: existing.tenantId },
    );
    return 'exists-non-active';
  }

  const userId = randomUUID();
  await users.create({
    userId,
    tenantId: bootstrap.tenantId,
    email: bootstrap.adminEmail,
    status: 'active',
  });

  const hash = await bcrypt.hash(bootstrap.adminPassword, bcryptCost);
  await credentials.setCredential({
    userId,
    providerId: 'email-password',
    hash,
  });

  await memberships.addMembership({
    userId,
    tenantId: bootstrap.tenantId,
    groupId: 'tenant-admin',
  });

  logger.info('bootstrap-admin: provisioned tenant-admin', {
    userId,
    tenantId: bootstrap.tenantId,
  });
  return 'provisioned';
};
