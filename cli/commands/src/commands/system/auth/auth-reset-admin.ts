/**
 * kb auth reset-admin — Recover the tenant admin account.
 *
 * Works offline against the platform document database (the same one the
 * gateway uses), so it is the way back in when nobody can log in: forgotten
 * password, credential lost, admin disabled, membership gone. It does not
 * talk to the gateway, and refuses to run while one is listening on the
 * configured port (a concurrent sqlite writer) unless --force is given.
 *
 * Without --yes it is a dry run: it reports what is wrong and what would be
 * repaired, and changes nothing. The password is never accepted as an
 * argument (it would land in shell history and `ps`): pass it on stdin with
 * --password-stdin, or let --generate mint one and print it once.
 */

import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { defineSystemCommand, type CommandResult } from '@kb-labs/shared-command-kit';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import { loadPlatformConfig, platform } from '@kb-labs/core-runtime';
import {
  CredentialsStore,
  MembershipsStore,
  ResetAdminError,
  SessionsStore,
  UsersStore,
  canonicalizeEmail,
  createPasswordPolicy,
  resetAdmin,
  type ResetAdminRepair,
  type User,
} from '@kb-labs/gateway-auth';

type ResetAdminFlags = {
  email: { type: 'string'; description: string };
  tenant: { type: 'string'; description: string };
  'password-stdin': { type: 'boolean'; description: string };
  generate: { type: 'boolean'; description: string };
  yes: { type: 'boolean'; description: string };
  force: { type: 'boolean'; description: string };
  json: { type: 'boolean'; description: string };
};

type ResetAdminCommandResult = CommandResult & {
  dryRun?: boolean;
  email?: string;
  tenantId?: string;
  userId?: string;
  outcome?: 'created' | 'reset';
  /** What was (or, on a dry run, would be) repaired. */
  repairs?: ResetAdminRepair[];
  /** Present only with --generate on a real run. Shown once. */
  generatedPassword?: string;
};

const DEFAULT_TENANT = 'kblabs-cloud';
const DEFAULT_GATEWAY_HOST = '127.0.0.1';
const DEFAULT_GATEWAY_PORT = 4000;
const PROBE_TIMEOUT_MS = 500;

interface GatewayAuthSlice {
  host?: string;
  port?: number;
  auth?: {
    bcryptCost?: number;
    passwordPolicy?: { minLength?: number; maxLength?: number; hibpEnabled?: boolean };
    bootstrap?: { tenantId?: string; adminEmail?: string };
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function gatewaySlice(config: Record<string, unknown> | undefined): GatewayAuthSlice {
  const gw = config?.gateway;
  return isRecord(gw) ? (gw as GatewayAuthSlice) : {};
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8').replace(/\r?\n$/, '');
}

function isPortListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function planRepairs(
  existing: User | null,
  tenantId: string,
  memberships: MembershipsStore,
): Promise<ResetAdminRepair[]> {
  if (!existing) {
    return ['user-created', 'credential-set', 'membership-created'];
  }
  const repairs: ResetAdminRepair[] = [];
  if (existing.status !== 'active') {repairs.push('user-reactivated');}
  repairs.push('credential-set');
  const membership = (await memberships.listByUser(existing.userId)).find((m) => m.tenantId === tenantId);
  if (!membership) {repairs.push('membership-created');}
  else if (membership.groupId !== 'tenant-admin') {repairs.push('membership-promoted');}
  return repairs;
}

function printDryRun(ctx: PluginContextV3, existing: User | null, dry: ResetAdminCommandResult): void {
  ctx.ui?.write?.(`Dry run — nothing changed.\n  Admin:  ${dry.email} (tenant ${dry.tenantId})\n`);
  ctx.ui?.write?.(existing ? `  State:  exists, status=${existing.status}\n` : '  State:  does not exist\n');
  ctx.ui?.write?.(`  Would:  ${dry.repairs?.join(', ')}, revoke all sessions\n`);
  ctx.ui?.write?.('Re-run with --yes and --password-stdin or --generate to apply.\n');
}

function printApplied(ctx: PluginContextV3, out: ResetAdminCommandResult): void {
  ctx.ui?.write?.(`Admin ${out.outcome === 'created' ? 'created' : 'restored'}: ${out.email} (tenant ${out.tenantId})\n`);
  ctx.ui?.write?.(`  Changes: ${out.repairs?.join(', ')}; all sessions revoked\n`);
  if (out.generatedPassword) {
    ctx.ui?.write?.(`  Password: ${out.generatedPassword}\n  Save it now — it is not shown again.\n`);
  }
}

export const authResetAdmin = defineSystemCommand<ResetAdminFlags, ResetAdminCommandResult>({
  name: 'reset-admin',
  description: 'Recover the tenant admin account (reset password, reactivate, restore role)',
  longDescription:
    'Offline recovery of the tenant admin against the platform database: creates the admin if missing, ' +
    'reactivates it, sets a new password, restores the tenant-admin membership and revokes all its sessions. ' +
    'Dry run unless --yes is given. The password is read from stdin (--password-stdin) or generated (--generate); ' +
    'it is never accepted as an argument.',
  category: 'auth',
  examples: [
    'kb auth reset-admin',
    'kb auth reset-admin --generate --yes',
    'printf %s "$NEW_PASSWORD" | kb auth reset-admin --password-stdin --yes',
    'kb auth reset-admin --email admin@example.com --tenant acme --generate --yes --json',
  ],
  flags: {
    email: { type: 'string', description: 'Admin email (default: GATEWAY_BOOTSTRAP_ADMIN_EMAIL or gateway.auth.bootstrap.adminEmail)' },
    tenant: { type: 'string', description: `Tenant id (default: GATEWAY_BOOTSTRAP_TENANT_ID or gateway.auth.bootstrap.tenantId, else ${DEFAULT_TENANT})` },
    'password-stdin': { type: 'boolean', description: 'Read the new password from stdin' },
    generate: { type: 'boolean', description: 'Generate a random password and print it once' },
    yes: { type: 'boolean', description: 'Apply the changes (without it this is a dry run)' },
    force: { type: 'boolean', description: 'Run even if a gateway is listening on the configured port' },
    json: { type: 'boolean', description: 'Output in JSON format' },
  },
  async handler(ctx, _argv, flags) {
    const fail = (msg: string): ResetAdminCommandResult => {
      if (flags.json) {
        ctx.ui?.json({ ok: false, error: msg });
      } else {
        ctx.ui?.error?.(msg);
      }
      return { ok: false, error: msg };
    };

    if (flags['password-stdin'] && flags.generate) {
      return fail('Use either --password-stdin or --generate, not both.');
    }
    if (flags.yes && !flags['password-stdin'] && !flags.generate) {
      return fail('A password source is required to apply: pass --password-stdin or --generate.');
    }

    const loaded = await loadPlatformConfig({ startDir: getContextCwd(ctx), loadEnvFile: true });
    const gw = gatewaySlice(loaded.effectiveConfig ?? loaded.rawConfig ?? loaded.rawPlatformConfig);

    const email = canonicalizeEmail(
      flags.email ?? process.env.GATEWAY_BOOTSTRAP_ADMIN_EMAIL ?? gw.auth?.bootstrap?.adminEmail ?? '',
    );
    if (!email) {
      return fail('Admin email is unknown: pass --email, or set GATEWAY_BOOTSTRAP_ADMIN_EMAIL / gateway.auth.bootstrap.adminEmail.');
    }
    const tenantId =
      flags.tenant ?? process.env.GATEWAY_BOOTSTRAP_TENANT_ID ?? gw.auth?.bootstrap?.tenantId ?? DEFAULT_TENANT;

    if (!platform.isReal('documentDatabase')) {
      return fail(
        'No persistent documentDatabase is configured for this project, so there is no admin account on disk to recover. ' +
        'Check `adapters.documentDatabase` in .kb/kb.config.json.',
      );
    }

    if (!flags.force) {
      const host = gw.host ?? DEFAULT_GATEWAY_HOST;
      const port = gw.port ?? DEFAULT_GATEWAY_PORT;
      if (await isPortListening(host, port)) {
        return fail(
          `A gateway appears to be running on ${host}:${port}. Stop it first (kb-dev stop gateway) so the database is not written concurrently, ` +
          'or pass --force if that is not the gateway.',
        );
      }
    }

    const docs = platform.documentDatabase;
    const users = new UsersStore(docs);
    const credentials = new CredentialsStore(docs);
    const memberships = new MembershipsStore(docs);
    const sessions = new SessionsStore(docs, {
      refreshTtlMs: 0,
      graceWindowMs: 0,
    });

    const existing = await users.findByEmailTenant(email, tenantId);

    if (!flags.yes) {
      const repairs = await planRepairs(existing, tenantId, memberships);
      const dry: ResetAdminCommandResult = {
        ok: true,
        dryRun: true,
        email,
        tenantId,
        userId: existing?.userId,
        outcome: existing ? 'reset' : 'created',
        repairs,
      };
      if (flags.json) {
        ctx.ui?.json(dry);
      } else {
        printDryRun(ctx, existing, dry);
      }
      return dry;
    }

    const generated = flags.generate ? randomBytes(18).toString('base64url') : undefined;
    const password = generated ?? (await readStdin());
    if (!password) {
      return fail('Empty password on stdin.');
    }

    const policy = gw.auth?.passwordPolicy;
    const bcryptCost = gw.auth?.bcryptCost ?? 12;

    try {
      const result = await resetAdmin({
        users,
        credentials,
        memberships,
        sessions,
        passwordPolicy: createPasswordPolicy({
          minLength: policy?.minLength ?? 8,
          maxLength: policy?.maxLength ?? 256,
          hibpEnabled: policy?.hibpEnabled ?? true,
        }),
        bcryptCost,
        tenantId,
        email,
        password,
        logger: {
          info: (...args) => platform.logger.info(String(args[0]), isRecord(args[1]) ? args[1] : undefined),
          warn: (...args) => platform.logger.warn(String(args[0]), isRecord(args[1]) ? args[1] : undefined),
        },
      });

      const out: ResetAdminCommandResult = {
        ok: true,
        dryRun: false,
        email: result.email,
        tenantId: result.tenantId,
        userId: result.userId,
        outcome: result.outcome,
        repairs: result.repairs,
        ...(generated ? { generatedPassword: generated } : {}),
      };
      if (flags.json) {
        ctx.ui?.json(out);
      } else {
        printApplied(ctx, out);
      }
      return out;
    } catch (err) {
      if (err instanceof ResetAdminError) {
        return fail(err.message);
      }
      throw err;
    }
  },
});
