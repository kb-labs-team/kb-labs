/**
 * @module @kb-labs/host-app/recover
 *
 * Administrator account recovery, run by the launcher as
 * `kb-create doctor --recover` while the host is stopped (ADR-0045: lifecycle
 * and recovery entries live in the launcher, not in the `kb` CLI).
 *
 * It works offline against the platform document database (the one the gateway
 * uses), so it is the way back in when nobody can log in: forgotten password,
 * lost credential, disabled admin, missing membership. It does not talk to the
 * gateway, and refuses to run while something listens on the configured
 * gateway port (a concurrent sqlite writer).
 *
 * Without `--yes` it is a dry run: it reports what is wrong and what would be
 * repaired, and changes nothing. The password is never accepted as an argument
 * (it would land in shell history and `ps`): pass it on stdin with
 * `--password-stdin`, or let `--generate` mint one and print it once.
 *
 * The module is pure over its inputs (`RecoverContext`); `recover-bin.ts` wires
 * the real platform, so tests run against an in-memory database.
 */

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import type { IDocumentDatabase } from "@kb-labs/core-platform";
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
} from "@kb-labs/gateway-auth";

export const DEFAULT_TENANT = "kblabs-cloud";
const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 4000;

export interface RecoverArgs {
  email?: string;
  tenant?: string;
  passwordStdin: boolean;
  generate: boolean;
  yes: boolean;
  json: boolean;
}

/** A command line the tool cannot act on (wrong flags); exit status 2. */
export class RecoverUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoverUsageError";
  }
}

/** Parses the flags the launcher forwards. Unknown flags are rejected. */
export function parseRecoverArgs(argv: readonly string[]): RecoverArgs {
  try {
    const { values } = parseArgs({
      args: [...argv],
      strict: true,
      options: {
        email: { type: "string" },
        tenant: { type: "string" },
        "password-stdin": { type: "boolean", default: false },
        generate: { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
    });
    return {
      email: values.email,
      tenant: values.tenant,
      passwordStdin: values["password-stdin"] ?? false,
      generate: values.generate ?? false,
      yes: values.yes ?? false,
      json: values.json ?? false,
    };
  } catch (error) {
    throw new RecoverUsageError(error instanceof Error ? error.message : String(error));
  }
}

/** The slice of the `gateway` config section the recovery reads. */
export interface GatewayAuthSlice {
  host?: string;
  port?: number;
  auth?: {
    bcryptCost?: number;
    passwordPolicy?: { minLength?: number; maxLength?: number; hibpEnabled?: boolean };
    bootstrap?: { tenantId?: string; adminEmail?: string };
  };
}

export interface RecoverLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface RecoverOutput {
  write(text: string): void;
  error(text: string): void;
  json(value: unknown): void;
}

export interface RecoverContext {
  /** The `gateway` config section of the effective config. */
  gateway: GatewayAuthSlice;
  /** Undefined when no persistent documentDatabase is configured. */
  documentDatabase: IDocumentDatabase | undefined;
  env: NodeJS.ProcessEnv;
  readStdin(): Promise<string>;
  isPortListening(host: string, port: number): Promise<boolean>;
  logger: RecoverLogger;
  out: RecoverOutput;
}

export interface RecoverResult {
  ok: boolean;
  dryRun?: boolean;
  email?: string;
  tenantId?: string;
  userId?: string;
  outcome?: "created" | "reset";
  /** What was (or, on a dry run, would be) repaired. */
  repairs?: ResetAdminRepair[];
  /** Present only with --generate on a real run. Shown once. */
  generatedPassword?: string;
  error?: string;
}

async function planRepairs(
  existing: User | null,
  tenantId: string,
  memberships: MembershipsStore,
): Promise<ResetAdminRepair[]> {
  if (!existing) {
    return ["user-created", "credential-set", "membership-created"];
  }
  const repairs: ResetAdminRepair[] = [];
  if (existing.status !== "active") {
    repairs.push("user-reactivated");
  }
  repairs.push("credential-set");
  const membership = (await memberships.listByUser(existing.userId)).find(
    (m) => m.tenantId === tenantId,
  );
  if (!membership) {
    repairs.push("membership-created");
  } else if (membership.groupId !== "tenant-admin") {
    repairs.push("membership-promoted");
  }
  return repairs;
}

/** The flag combinations that cannot be acted on, as a message. */
function flagProblem(args: RecoverArgs): string | undefined {
  if (args.passwordStdin && args.generate) {
    return "Use either --password-stdin or --generate, not both.";
  }
  if (args.yes && !args.passwordStdin && !args.generate) {
    return "A password source is required to apply: pass --password-stdin or --generate.";
  }
  return undefined;
}

interface AdminIdentity {
  email: string;
  tenantId: string;
}

/** Email and tenant, or the reason they cannot be determined. */
function resolveIdentity(args: RecoverArgs, context: RecoverContext): AdminIdentity | string {
  const auth = context.gateway.auth;
  const email = canonicalizeEmail(
    args.email ?? context.env.GATEWAY_BOOTSTRAP_ADMIN_EMAIL ?? auth?.bootstrap?.adminEmail ?? "",
  );
  if (!email) {
    return "Admin email is unknown: pass --email, or set GATEWAY_BOOTSTRAP_ADMIN_EMAIL / gateway.auth.bootstrap.adminEmail.";
  }
  // The gateway's own order (config, then env, then default): a recovery that
  // used another order would repair an admin in a tenant nobody logs into.
  const tenantId =
    args.tenant ?? auth?.bootstrap?.tenantId ?? context.env.GATEWAY_BOOTSTRAP_TENANT_ID ?? DEFAULT_TENANT;
  return { email, tenantId };
}

interface Stores {
  users: UsersStore;
  credentials: CredentialsStore;
  memberships: MembershipsStore;
  sessions: SessionsStore;
}

function reportDryRun(
  args: RecoverArgs,
  out: RecoverOutput,
  identity: AdminIdentity,
  existing: User | null,
  repairs: ResetAdminRepair[],
): void {
  const dry: RecoverResult = {
    ok: true,
    dryRun: true,
    ...identity,
    userId: existing?.userId,
    outcome: existing ? "reset" : "created",
    repairs,
  };
  if (args.json) {
    out.json(dry);
    return;
  }
  out.write(
    `Dry run — nothing changed.\n  Admin:  ${identity.email} (tenant ${identity.tenantId})\n` +
      (existing ? `  State:  exists, status=${existing.status}\n` : "  State:  does not exist\n") +
      `  Would:  ${repairs.join(", ")}, revoke all sessions\n` +
      "Re-run with --yes and --password-stdin or --generate to apply.\n",
  );
}

function reportApplied(
  args: RecoverArgs,
  out: RecoverOutput,
  result: Awaited<ReturnType<typeof resetAdmin>>,
  generated: string | undefined,
): void {
  if (args.json) {
    out.json({
      ok: true,
      dryRun: false,
      email: result.email,
      tenantId: result.tenantId,
      userId: result.userId,
      outcome: result.outcome,
      repairs: result.repairs,
      ...(generated ? { generatedPassword: generated } : {}),
    } satisfies RecoverResult);
    return;
  }
  out.write(
    `Admin ${result.outcome === "created" ? "created" : "restored"}: ${result.email} (tenant ${result.tenantId})\n` +
      `  Changes: ${result.repairs.join(", ")}; all sessions revoked\n` +
      (generated ? `  Password: ${generated}\n  Save it now — it is not shown again.\n` : ""),
  );
}

/**
 * Runs the recovery and returns the process exit status: 0 on success (a dry
 * run included), 1 when the recovery could not be done.
 */
export async function runRecover(args: RecoverArgs, context: RecoverContext): Promise<number> {
  const { out, gateway } = context;
  const fail = (message: string): number => {
    if (args.json) {
      out.json({ ok: false, error: message } satisfies RecoverResult);
    } else {
      out.error(message);
    }
    return 1;
  };

  const problem = flagProblem(args);
  if (problem) {
    return fail(problem);
  }
  const identity = resolveIdentity(args, context);
  if (typeof identity === "string") {
    return fail(identity);
  }
  const docs = context.documentDatabase;
  if (!docs) {
    return fail(
      "No persistent documentDatabase is configured for this project, so there is no admin account on disk to recover. " +
        "Check `platform.adapters.documentDatabase` in the platform config.",
    );
  }
  const host = gateway.host ?? DEFAULT_GATEWAY_HOST;
  const port = gateway.port ?? DEFAULT_GATEWAY_PORT;
  if (await context.isPortListening(host, port)) {
    return fail(
      `Something is listening on ${host}:${port}, so the host may be running and writing to the database. ` +
        'Run "kb-create stop" first.',
    );
  }

  const stores: Stores = {
    users: new UsersStore(docs),
    credentials: new CredentialsStore(docs),
    memberships: new MembershipsStore(docs),
    sessions: new SessionsStore(docs, { refreshTtlMs: 0, graceWindowMs: 0 }),
  };
  const existing = await stores.users.findByEmailTenant(identity.email, identity.tenantId);
  if (!args.yes) {
    reportDryRun(args, out, identity, existing, await planRepairs(existing, identity.tenantId, stores.memberships));
    return 0;
  }

  const generated = args.generate ? randomBytes(18).toString("base64url") : undefined;
  const password = generated ?? (await context.readStdin());
  if (!password) {
    return fail("Empty password on stdin.");
  }
  try {
    reportApplied(args, out, await applyRecovery(context, stores, identity, password), generated);
    return 0;
  } catch (error) {
    if (error instanceof ResetAdminError) {
      return fail(error.message);
    }
    throw error;
  }
}

function applyRecovery(
  context: RecoverContext,
  stores: Stores,
  identity: AdminIdentity,
  password: string,
): ReturnType<typeof resetAdmin> {
  const auth = context.gateway.auth;
  const policy = auth?.passwordPolicy;
  return resetAdmin({
    ...stores,
    passwordPolicy: createPasswordPolicy({
      minLength: policy?.minLength ?? 8,
      maxLength: policy?.maxLength ?? 256,
      hibpEnabled: policy?.hibpEnabled ?? true,
    }),
    bcryptCost: auth?.bcryptCost ?? 12,
    ...identity,
    password,
    logger: {
      info: (...logArgs) => context.logger.info(String(logArgs[0]), asRecord(logArgs[1])),
      warn: (...logArgs) => context.logger.warn(String(logArgs[0]), asRecord(logArgs[1])),
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
