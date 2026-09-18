/**
 * @module cli-commands/__tests__/auth-reset-admin
 *
 * `kb auth reset-admin` recovers the admin against the platform database.
 * The gateway-auth stores and password hashing are real (in-memory document
 * database); only platform wiring is mocked. The running-gateway guard is
 * exercised against a genuine listening socket.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { Readable } from 'node:stream';
import { noopUI, noopTraceContext } from '@kb-labs/plugin-contracts';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import { createInMemoryDocumentDatabase } from '@kb-labs/core-platform/inmemory';

const EMAIL = 'admin@kblabs.ru';
const TENANT = 'kblabs-cloud';

const state = vi.hoisted(() => ({
  docs: undefined as unknown,
  isReal: true,
  gateway: {} as Record<string, unknown>,
}));

vi.mock('@kb-labs/core-runtime', () => ({
  platform: {
    isReal: () => state.isReal,
    get documentDatabase() { return state.docs; },
    logger: { info: vi.fn(), warn: vi.fn() },
  },
  loadPlatformConfig: vi.fn(async () => ({
    effectiveConfig: { gateway: state.gateway },
  })),
}));

import { authResetAdmin } from '../commands/system/auth/auth-reset-admin.js';
import { UsersStore, CredentialsStore, MembershipsStore, createEmailPasswordProvider } from '@kb-labs/gateway-auth';

/** Verifies a password through the same provider the gateway login uses. */
const canLogin = async (password: string): Promise<boolean> => {
  const provider = createEmailPasswordProvider({ users, credentials, tenantId: TENANT, bcryptCost: 4 });
  return (await provider.authenticate({ email: EMAIL, password })).ok;
};

type Captured = { errors: string[]; output: string[]; json: any[] };

function makeCtx(captured: Captured): PluginContextV3 {
  return {
    host: 'cli', requestId: 't', pluginId: '@kb-labs/system', pluginVersion: '1.0.0', cwd: process.cwd(),
    ui: {
      ...noopUI,
      write: (m: string) => { captured.output.push(m); },
      error: (m: string) => { captured.errors.push(m); },
      json: (o: unknown) => { captured.json.push(o); },
    },
    platform: {} as any, runtime: {} as any, api: {} as any,
    hostContext: { host: 'cli' as const, argv: [], flags: {} },
    trace: noopTraceContext,
  };
}

const FLAGS = { email: undefined, tenant: undefined, 'password-stdin': false, generate: false, yes: false, force: false, json: true };
const run = async (flags: Partial<Record<keyof typeof FLAGS, string | boolean | undefined>>) => {
  const captured: Captured = { errors: [], output: [], json: [] };
  const exitCode = await authResetAdmin.run(makeCtx(captured), [], { ...FLAGS, email: EMAIL, tenant: TENANT, ...flags } as any);
  return { exitCode, captured };
};

let users: UsersStore;
let credentials: CredentialsStore;
let memberships: MembershipsStore;
const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;

const pipeStdin = (text: string) =>
  Object.defineProperty(process, 'stdin', { value: Readable.from([text]), configurable: true });

beforeEach(() => {
  const docs = createInMemoryDocumentDatabase();
  state.docs = docs;
  state.isReal = true;
  // Port 1 is never listening; individual tests override it.
  state.gateway = { host: '127.0.0.1', port: 1, auth: { bcryptCost: 4, passwordPolicy: { hibpEnabled: false } } };
  users = new UsersStore(docs);
  credentials = new CredentialsStore(docs);
  memberships = new MembershipsStore(docs);
  delete process.env.GATEWAY_BOOTSTRAP_ADMIN_EMAIL;
  delete process.env.GATEWAY_BOOTSTRAP_TENANT_ID;
});

afterEach(() => {
  Object.defineProperty(process, 'stdin', realStdin);
});

describe('kb auth reset-admin', () => {
  it('is a dry run without --yes: reports the plan, changes nothing', async () => {
    const { exitCode, captured } = await run({});

    expect(exitCode).toBe(0);
    expect(captured.json[0]).toMatchObject({ ok: true, dryRun: true, outcome: 'created' });
    expect(await users.findByEmailTenant(EMAIL, TENANT)).toBeNull();
  });

  it('creates the admin with a generated password that really verifies, printed once', async () => {
    const { exitCode, captured } = await run({ generate: true, yes: true });

    expect(exitCode).toBe(0);
    const out = captured.json[0];
    expect(out).toMatchObject({ ok: true, dryRun: false, outcome: 'created' });
    expect(out.generatedPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const user = await users.findByEmailTenant(EMAIL, TENANT);
    expect(await canLogin(out.generatedPassword)).toBe(true);
    expect((await memberships.listByUser(user!.userId))[0]?.groupId).toBe('tenant-admin');
  });

  it('repairs a stranded admin (disabled, no credential) with a password from stdin', async () => {
    await users.create({ userId: 'u1', tenantId: TENANT, email: EMAIL, status: 'disabled' });
    pipeStdin('a-strong-stdin-password\n');

    const { exitCode, captured } = await run({ 'password-stdin': true, yes: true });

    expect(exitCode).toBe(0);
    expect(captured.json[0]).toMatchObject({ outcome: 'reset', userId: 'u1' });
    expect(captured.json[0].generatedPassword).toBeUndefined();
    expect((await users.getById('u1'))?.status).toBe('active');
    expect(await canLogin('a-strong-stdin-password')).toBe(true);
  });

  it('rejects a weak password and leaves the database untouched', async () => {
    pipeStdin('short\n');

    const { exitCode, captured } = await run({ 'password-stdin': true, yes: true });

    expect(exitCode).not.toBe(0);
    expect(captured.json[0]).toMatchObject({ ok: false });
    expect(await users.findByEmailTenant(EMAIL, TENANT)).toBeNull();
  });

  it('requires a password source to apply', async () => {
    const { exitCode, captured } = await run({ yes: true });

    expect(exitCode).not.toBe(0);
    expect(captured.json[0].error).toMatch(/--password-stdin or --generate/);
  });

  it('rejects --password-stdin together with --generate', async () => {
    const { exitCode } = await run({ 'password-stdin': true, generate: true, yes: true });
    expect(exitCode).not.toBe(0);
  });

  it('fails clearly when the email cannot be determined', async () => {
    const { exitCode, captured } = await run({ email: undefined, generate: true, yes: true });

    expect(exitCode).not.toBe(0);
    expect(captured.json[0].error).toMatch(/email is unknown/i);
  });

  it('takes email and tenant from the GATEWAY_BOOTSTRAP_* env when flags are absent', async () => {
    process.env.GATEWAY_BOOTSTRAP_ADMIN_EMAIL = 'env-admin@kblabs.ru';
    process.env.GATEWAY_BOOTSTRAP_TENANT_ID = 'env-tenant';

    const { captured } = await run({ email: undefined, tenant: undefined });

    expect(captured.json[0]).toMatchObject({ email: 'env-admin@kblabs.ru', tenantId: 'env-tenant' });
  });

  it("resolves the tenant in the gateway's own order: config, then env (config wins)", async () => {
    // The gateway reads config before GATEWAY_BOOTSTRAP_TENANT_ID; a reset that used the
    // opposite order would create/repair the admin in a tenant the gateway never logs into.
    process.env.GATEWAY_BOOTSTRAP_TENANT_ID = 'env-tenant';
    state.gateway = { ...state.gateway, auth: { ...(state.gateway.auth as object), bootstrap: { tenantId: 'config-tenant' } } };

    const { captured } = await run({ tenant: undefined });

    expect(captured.json[0]).toMatchObject({ tenantId: 'config-tenant' });
  });

  it('an explicit --tenant beats both', async () => {
    process.env.GATEWAY_BOOTSTRAP_TENANT_ID = 'env-tenant';
    state.gateway = { ...state.gateway, auth: { ...(state.gateway.auth as object), bootstrap: { tenantId: 'config-tenant' } } };

    const { captured } = await run({ tenant: 'flag-tenant' });

    expect(captured.json[0]).toMatchObject({ tenantId: 'flag-tenant' });
  });

  it('refuses when no persistent documentDatabase is configured', async () => {
    state.isReal = false;

    const { exitCode, captured } = await run({ generate: true, yes: true });

    expect(exitCode).not.toBe(0);
    expect(captured.json[0].error).toMatch(/documentDatabase/);
  });

  describe('running-gateway guard', () => {
    let server: Server;
    let port: number;

    beforeEach(async () => {
      server = createServer();
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(); }); });
      port = (server.address() as { port: number }).port;
      state.gateway = { ...state.gateway, port };
    });
    afterEach(() => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }));

    it('refuses while something listens on the gateway port, and writes nothing', async () => {
      const { exitCode, captured } = await run({ generate: true, yes: true });

      expect(exitCode).not.toBe(0);
      expect(captured.json[0].error).toMatch(/gateway appears to be running/i);
      expect(await users.findByEmailTenant(EMAIL, TENANT)).toBeNull();
    });

    it('--force overrides the guard', async () => {
      const { exitCode, captured } = await run({ generate: true, yes: true, force: true });

      expect(exitCode).toBe(0);
      expect(captured.json[0]).toMatchObject({ ok: true, outcome: 'created' });
    });
  });
});
