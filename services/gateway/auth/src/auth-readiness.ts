/**
 * @module @kb-labs/gateway-auth/auth-readiness
 *
 * "Can anyone actually log in, and is the setup safe?" — evaluated from the
 * live stores rather than guessed from configuration.
 *
 * A gateway with `auth.enabled` (the default) and no active tenant-admin is
 * locked out: nobody can log in, and nothing in the login response says why
 * (CD-8 makes every failure look identical). This is exactly the state a
 * fresh secured install lands in when no bootstrap admin was seeded. The
 * gateway logs the result at startup and exposes it to the local operator
 * (see `/health/auth`), so `kb-dev doctor` can name the problem and the fix.
 *
 * The result carries codes, counts and hints only — never secret values.
 */

import type { UsersStore } from './users-store.js';
import type { MembershipsStore } from './memberships-store.js';
import type { BootstrapOutcome } from './bootstrap-admin.js';

export type AuthIssueCode =
  | 'no_active_admin'
  | 'jwt_secret_default'
  | 'bootstrap_failed'
  | 'bootstrap_user_inactive';

export interface AuthIssue {
  code: AuthIssueCode;
  severity: 'error' | 'warning';
  message: string;
  /** What the operator should run/change. */
  hint: string;
}

export type BootstrapStatus = BootstrapOutcome | 'failed';

export interface AuthReadinessInput {
  authEnabled: boolean;
  /** True when the gateway is bound to a loopback address only. */
  loopbackOnly: boolean;
  tenantId: string;
  /** True when the JWT secret is the built-in public development default. */
  jwtSecretIsDefault: boolean;
  bootstrap: {
    status: BootstrapStatus;
    /** Configured bootstrap email; used only to make hints copy-pasteable. */
    email?: string;
  };
  users: Pick<UsersStore, 'getById'>;
  memberships: Pick<MembershipsStore, 'listByTenant'>;
}

export interface AuthReadiness {
  /** False when any issue has severity `error`. */
  ok: boolean;
  authEnabled: boolean;
  tenantId: string;
  activeAdmins: number;
  bootstrap: BootstrapStatus;
  issues: AuthIssue[];
}

const countActiveAdmins = async (
  users: AuthReadinessInput['users'],
  memberships: AuthReadinessInput['memberships'],
  tenantId: string,
): Promise<number> => {
  const admins = (await memberships.listByTenant(tenantId)).filter((m) => m.groupId === 'tenant-admin');
  const found = await Promise.all(admins.map((m) => users.getById(m.userId)));
  return found.filter((u) => u !== null && u.tenantId === tenantId && u.status === 'active').length;
};

export const evaluateAuthReadiness = async (input: AuthReadinessInput): Promise<AuthReadiness> => {
  const { authEnabled, tenantId, bootstrap } = input;

  if (!authEnabled) {
    // Solo/local mode: every request already runs as the local admin.
    return { ok: true, authEnabled, tenantId, activeAdmins: 0, bootstrap: bootstrap.status, issues: [] };
  }

  const activeAdmins = await countActiveAdmins(input.users, input.memberships, tenantId);
  const issues: AuthIssue[] = [];
  const emailArg = bootstrap.email ?? '<admin-email>';

  if (activeAdmins === 0) {
    issues.push({
      code: 'no_active_admin',
      severity: 'error',
      message: `Authentication is enabled but tenant "${tenantId}" has no active admin — nobody can log in.`,
      hint: `Stop the gateway, then run: kb auth reset-admin --email ${emailArg} --tenant ${tenantId} --generate --yes`,
    });
  }

  if (bootstrap.status === 'failed') {
    issues.push({
      code: 'bootstrap_failed',
      severity: 'error',
      message: 'Seeding the bootstrap admin failed at startup.',
      hint: 'Check the gateway startup logs for "Bootstrap admin seed failed", fix the cause, or run: kb auth reset-admin',
    });
  } else if (bootstrap.status === 'exists-non-active') {
    issues.push({
      code: 'bootstrap_user_inactive',
      severity: 'warning',
      message: 'The bootstrap admin exists but is not active; bootstrap never re-activates existing users.',
      hint: `Reactivate it with: kb auth reset-admin --email ${emailArg} --tenant ${tenantId}`,
    });
  }

  if (input.jwtSecretIsDefault) {
    issues.push({
      code: 'jwt_secret_default',
      severity: input.loopbackOnly ? 'warning' : 'error',
      message: 'GATEWAY_JWT_SECRET is not set: tokens are signed with a public development secret and can be forged.',
      hint: 'Set GATEWAY_JWT_SECRET (e.g. `openssl rand -hex 64`) and restart the gateway; existing sessions are invalidated.',
    });
  }

  return {
    ok: !issues.some((i) => i.severity === 'error'),
    authEnabled,
    tenantId,
    activeAdmins,
    bootstrap: bootstrap.status,
    issues,
  };
};
