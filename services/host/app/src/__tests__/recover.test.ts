/**
 * `kb-recover` (run by `kb-create doctor --recover`) restores the tenant admin
 * against the platform database. The gateway-auth stores and password hashing
 * are real (in-memory document database); only platform wiring is injected.
 * The running-gateway guard is exercised against a genuine listening socket.
 */

import { createServer, connect, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDocumentDatabase } from "@kb-labs/core-platform/inmemory";
import {
  CredentialsStore,
  MembershipsStore,
  UsersStore,
  createEmailPasswordProvider,
} from "@kb-labs/gateway-auth";
import {
  RecoverUsageError,
  parseRecoverArgs,
  runRecover,
  type GatewayAuthSlice,
  type RecoverArgs,
  type RecoverContext,
} from "../recover.js";

const EMAIL = "admin@kblabs.ru";
const TENANT = "kblabs-cloud";

const NO_ARGS: RecoverArgs = {
  email: EMAIL,
  tenant: TENANT,
  passwordStdin: false,
  generate: false,
  yes: false,
  json: true,
};

interface Captured {
  json: Array<Record<string, unknown>>;
  text: string[];
  errors: string[];
}

let docs: ReturnType<typeof createInMemoryDocumentDatabase>;
let users: UsersStore;
let credentials: CredentialsStore;
let memberships: MembershipsStore;
let gateway: GatewayAuthSlice;
let env: NodeJS.ProcessEnv;
let stdin: string;
let persistent: boolean;

beforeEach(() => {
  docs = createInMemoryDocumentDatabase();
  users = new UsersStore(docs);
  credentials = new CredentialsStore(docs);
  memberships = new MembershipsStore(docs);
  // Port 1 is never listening; individual tests override it.
  gateway = {
    host: "127.0.0.1",
    port: 1,
    auth: { bcryptCost: 4, passwordPolicy: { hibpEnabled: false } },
  };
  env = {};
  stdin = "";
  persistent = true;
});

function probe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function run(overrides: Partial<RecoverArgs> = {}) {
  const captured: Captured = { json: [], text: [], errors: [] };
  const context: RecoverContext = {
    gateway,
    documentDatabase: persistent ? docs : undefined,
    env,
    readStdin: async () => stdin,
    isPortListening: probe,
    logger: { info: () => undefined, warn: () => undefined },
    out: {
      write: (text) => captured.text.push(text),
      error: (text) => captured.errors.push(text),
      json: (value) => captured.json.push(value as Record<string, unknown>),
    },
  };
  const exitCode = await runRecover({ ...NO_ARGS, ...overrides }, context);
  return { exitCode, captured };
}

/** Verifies a password through the same provider the gateway login uses. */
async function canLogin(password: string): Promise<boolean> {
  const provider = createEmailPasswordProvider({
    users,
    credentials,
    tenantId: TENANT,
    bcryptCost: 4,
  });
  return (await provider.authenticate({ email: EMAIL, password })).ok;
}

describe("kb-recover", () => {
  it("is a dry run without --yes: reports the plan, changes nothing", async () => {
    const { exitCode, captured } = await run();

    expect(exitCode).toBe(0);
    expect(captured.json[0]).toMatchObject({ ok: true, dryRun: true, outcome: "created" });
    expect(await users.findByEmailTenant(EMAIL, TENANT)).toBeNull();
  });

  it("prints a readable dry-run report without --json", async () => {
    const { exitCode, captured } = await run({ json: false });

    expect(exitCode).toBe(0);
    expect(captured.text.join("")).toContain("Dry run — nothing changed.");
    expect(captured.text.join("")).toContain("user-created, credential-set, membership-created");
  });

  it("creates the admin with a generated password that really verifies, printed once", async () => {
    const { exitCode, captured } = await run({ generate: true, yes: true });

    expect(exitCode).toBe(0);
    const out = captured.json[0]!;
    expect(out).toMatchObject({ ok: true, dryRun: false, outcome: "created" });
    expect(out.generatedPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const user = await users.findByEmailTenant(EMAIL, TENANT);
    expect(await canLogin(out.generatedPassword as string)).toBe(true);
    expect((await memberships.listByUser(user!.userId))[0]?.groupId).toBe("tenant-admin");
  });

  it("repairs a stranded admin (disabled, no credential) with a password from stdin", async () => {
    await users.create({ userId: "u1", tenantId: TENANT, email: EMAIL, status: "disabled" });
    stdin = "a-strong-stdin-password";

    const { exitCode, captured } = await run({ passwordStdin: true, yes: true });

    expect(exitCode).toBe(0);
    expect(captured.json[0]).toMatchObject({ outcome: "reset", userId: "u1" });
    expect(captured.json[0]!.generatedPassword).toBeUndefined();
    expect((await users.getById("u1"))?.status).toBe("active");
    expect(await canLogin("a-strong-stdin-password")).toBe(true);
  });

  it("rejects a weak password and leaves the database untouched", async () => {
    stdin = "short";

    const { exitCode, captured } = await run({ passwordStdin: true, yes: true });

    expect(exitCode).not.toBe(0);
    expect(captured.json[0]).toMatchObject({ ok: false });
    expect(await users.findByEmailTenant(EMAIL, TENANT)).toBeNull();
  });

  it("requires a password source to apply", async () => {
    const { exitCode, captured } = await run({ yes: true });

    expect(exitCode).not.toBe(0);
    expect(captured.json[0]!.error).toMatch(/--password-stdin or --generate/);
  });

  it("rejects --password-stdin together with --generate", async () => {
    const { exitCode } = await run({ passwordStdin: true, generate: true, yes: true });
    expect(exitCode).not.toBe(0);
  });

  it("fails clearly when the email cannot be determined", async () => {
    const { exitCode, captured } = await run({ email: undefined, generate: true, yes: true });

    expect(exitCode).not.toBe(0);
    expect(captured.json[0]!.error).toMatch(/email is unknown/i);
  });

  it("takes email and tenant from the GATEWAY_BOOTSTRAP_* env when flags are absent", async () => {
    env = { GATEWAY_BOOTSTRAP_ADMIN_EMAIL: "env-admin@kblabs.ru", GATEWAY_BOOTSTRAP_TENANT_ID: "env-tenant" };

    const { captured } = await run({ email: undefined, tenant: undefined });

    expect(captured.json[0]).toMatchObject({ email: "env-admin@kblabs.ru", tenantId: "env-tenant" });
  });

  it("resolves the tenant in the gateway's own order: config, then env (config wins)", async () => {
    // The gateway reads config before GATEWAY_BOOTSTRAP_TENANT_ID; a recovery that used the
    // opposite order would repair the admin in a tenant the gateway never logs into.
    env = { GATEWAY_BOOTSTRAP_TENANT_ID: "env-tenant" };
    gateway = { ...gateway, auth: { ...gateway.auth, bootstrap: { tenantId: "config-tenant" } } };

    const { captured } = await run({ tenant: undefined });

    expect(captured.json[0]).toMatchObject({ tenantId: "config-tenant" });
  });

  it("an explicit --tenant beats both", async () => {
    env = { GATEWAY_BOOTSTRAP_TENANT_ID: "env-tenant" };
    gateway = { ...gateway, auth: { ...gateway.auth, bootstrap: { tenantId: "config-tenant" } } };

    const { captured } = await run({ tenant: "flag-tenant" });

    expect(captured.json[0]).toMatchObject({ tenantId: "flag-tenant" });
  });

  it("refuses when no persistent documentDatabase is configured", async () => {
    persistent = false;

    const { exitCode, captured } = await run({ generate: true, yes: true });

    expect(exitCode).not.toBe(0);
    expect(captured.json[0]!.error).toMatch(/documentDatabase/);
  });

  describe("running-host guard", () => {
    let server: Server;

    beforeEach(async () => {
      server = createServer();
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve();
        });
      });
      gateway = { ...gateway, port: (server.address() as { port: number }).port };
    });
    afterEach(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    );

    it("refuses while something listens on the gateway port, and writes nothing", async () => {
      const { exitCode, captured } = await run({ generate: true, yes: true });

      expect(exitCode).not.toBe(0);
      expect(captured.json[0]!.error).toMatch(/kb-create stop/);
      expect(await users.findByEmailTenant(EMAIL, TENANT)).toBeNull();
    });
  });
});

describe("kb-recover command line", () => {
  it("parses the flags the launcher forwards", () => {
    expect(
      parseRecoverArgs(["--email", "a@b.c", "--tenant", "acme", "--generate", "--yes", "--json"]),
    ).toEqual({
      email: "a@b.c",
      tenant: "acme",
      passwordStdin: false,
      generate: true,
      yes: true,
      json: true,
    });
    expect(parseRecoverArgs(["--password-stdin"])).toMatchObject({ passwordStdin: true, yes: false });
  });

  it("rejects unknown flags and a password given as an argument", () => {
    expect(() => parseRecoverArgs(["--force"])).toThrow(RecoverUsageError);
    expect(() => parseRecoverArgs(["--password", "hunter2"])).toThrow(RecoverUsageError);
  });
});
