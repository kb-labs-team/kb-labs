/**
 * Process-level e2e for "Studio access": a REAL gateway process, started the way
 * the installer's output starts it (kb-dev, generated config, secrets resolved
 * from the private store), driven over real HTTP against a real sqlite file.
 *
 * The gateway configuration is not restated here: it is materialised from the
 * gateway's own kb-create.requirements.json, exactly as the installer does, so a
 * drift between what the installer writes and what the gateway reads fails here.
 *
 * Needs: the built gateway + adapters (`kb-devkit run build`) and a kb-dev binary
 * (`KB_DEV_BIN`, default tools/kb-dev/kb-dev). Without them the suite is skipped
 * with an explicit warning rather than passing vacuously.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const kbDev = process.env.KB_DEV_BIN ?? join(repoRoot, 'tools/kb-dev/kb-dev');
const gatewayEntry = join(repoRoot, 'services/gateway/app/dist/bin.js');
const adapters = ['sqlite', 'service-transport-http'].map((name) => ({
  pkg: `@kb-labs/adapters-${name}`,
  dir: join(repoRoot, 'adapters', name),
}));

const missing = [
  ...(existsSync(kbDev) ? [] : [`kb-dev binary (${kbDev})`]),
  ...(existsSync(gatewayEntry) ? [] : ['built gateway (services/gateway/app/dist)']),
  ...adapters.filter((a) => !existsSync(join(a.dir, 'dist'))).map((a) => `built ${a.pkg}`),
];
if (missing.length > 0) {
  console.warn(`[access-modes.e2e] SKIPPED — missing: ${missing.join(', ')}`);
}

// ── What the installer would write ──────────────────────────────────────────

interface Requirement { id: string; path?: string; default?: unknown; secret?: boolean; env?: string }
const requirements = (JSON.parse(
  readFileSync(join(repoRoot, 'services/gateway/app/kb-create.requirements.json'), 'utf8'),
) as { requirements: Requirement[] }).requirements;

const setPointer = (target: Record<string, unknown>, pointer: string, value: unknown): void => {
  const parts = pointer.split('/').slice(1);
  let cursor = target;
  for (const part of parts.slice(0, -1)) {cursor = (cursor[part] ??= {}) as Record<string, unknown>;}
  cursor[parts[parts.length - 1]!] = value;
};

const ADMIN_EMAIL = 'admin@e2e.example';
const ADMIN_PASSWORD = 'E2e-Admin-Pass-42';
const JWT_SECRET = 'e2e-signing-secret-0123456789abcdef0123456789abcdef';

interface Choices {
  mode: 'local' | 'secured';
  /** Secret values by requirement id; only these are wired into the service env. */
  secrets?: Record<string, string>;
  adminEmail?: string;
  /** Literal environment for the service, as an operator would set it. */
  env?: Record<string, string>;
}

// ── Process + HTTP plumbing ─────────────────────────────────────────────────

const run = (args: string[]) =>
  new Promise<{ code: number; out: string }>((done) => {
    execFile(kbDev, args, { timeout: 90_000, env: { ...process.env, NO_COLOR: '1' } }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: `${stdout}${stderr}` });
    });
  });

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

interface Reply { status: number; body: string }
const http = (port: number, path: string, opts: { method?: string; headers?: Record<string, string>; json?: unknown } = {}) =>
  new Promise<Reply>((done, fail) => {
    const payload = opts.json === undefined ? undefined : JSON.stringify(opts.json);
    const req = request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', fail);
    req.setTimeout(10_000, () => req.destroy(new Error(`timeout: ${path}`)));
    if (payload) {req.write(payload);}
    req.end();
  });

/** True when a TCP connection to host:port is accepted. */
const reachable = (host: string, port: number) =>
  new Promise<boolean>((done) => {
    const socket = connect({ host, port });
    socket.setTimeout(2_000, () => { socket.destroy(); done(false); });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => done(false));
  });

const externalAddress = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

interface Instance { port: number; stop: () => Promise<void> }
const running: Instance[] = [];

const startGateway = async (choices: Choices): Promise<Instance> => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-access-e2e-'));
  const port = await freePort();

  // The installer materialises requirement paths + defaults, then the user's answers.
  const config: Record<string, unknown> = {};
  for (const r of requirements.filter((x) => !x.secret && x.default !== undefined)) {setPointer(config, r.path!, r.default);}
  setPointer(config, '/gateway/access/mode', choices.mode);
  if (choices.adminEmail) {setPointer(config, '/gateway/auth/bootstrap/adminEmail', choices.adminEmail);}
  // Harness-only knobs: this gateway's port, a cheap bcrypt, no outbound HIBP call.
  setPointer(config, '/gateway/port', port);
  setPointer(config, '/gateway/auth/bcryptCost', 6);
  setPointer(config, '/gateway/auth/passwordPolicy', { hibpEnabled: false });

  mkdirSync(join(dir, '.kb/v2'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/@kb-labs'), { recursive: true });
  for (const a of adapters) {symlinkSync(a.dir, join(dir, 'node_modules', a.pkg));}
  const gateway = (config as { gateway: Record<string, unknown> }).gateway;
  writeFileSync(join(dir, '.kb/kb.config.json'), JSON.stringify({
    platform: {
      adapters: { documentDatabase: '@kb-labs/adapters-sqlite', serviceTransport: '@kb-labs/adapters-service-transport-http' },
      adapterOptions: {
        documentDatabase: { filename: '.kb/database/kb.sqlite' },
        serviceTransport: { services: { rest: { url: 'http://127.0.0.1:1' } } },
      },
    },
    gateway,
  }));

  // Secrets: env references in the service, values in the private store keyed by
  // the variable name — the state the installer's apply step leaves behind.
  const wired = requirements.filter((r) => r.secret && choices.secrets?.[r.id] !== undefined);
  writeFileSync(join(dir, '.kb/v2/secrets.env'), wired.map((r) => `${r.env}=${choices.secrets![r.id]}`).join('\n') + (wired.length ? '\n' : ''), { mode: 0o600 });
  const envLines = [
    ...wired.map((r) => `      ${r.env}: "\${${r.env}}"`),
    ...Object.entries(choices.env ?? {}).map(([k, v]) => `      ${k}: "${v}"`),
  ];
  const envBlock = envLines.length ? `    env:\n${envLines.join('\n')}\n` : '';
  const yaml = join(dir, '.kb/devservices.yaml');
  writeFileSync(yaml, [
    'name: access-modes e2e', 'groups:', '  backend: [gateway]', 'services:', '  gateway:', '    name: Gateway',
    '    description: gateway under test', '    group: backend', '    type: node',
    `    command: node ${gatewayEntry}`, `    health_check: http://localhost:${port}/health`, `    port: ${port}`, `    url: http://localhost:${port}`,
  ].join('\n') + '\n' + envBlock);

  const args = (verb: string) => [verb, 'gateway', '--config', yaml, '--net-offset', '0'];
  const started = await run(args('start'));
  const instance: Instance = {
    port,
    stop: async () => { await run(args('stop')); rmSync(dir, { recursive: true, force: true }); },
  };
  running.push(instance);
  if (started.code !== 0) {throw new Error(`kb-dev start failed:\n${started.out}`);}
  return instance;
};

afterEach(async () => {
  while (running.length > 0) {await running.pop()!.stop();}
});

const login = (port: number, email: string, password: string, tenantId = 'kblabs-cloud') =>
  http(port, '/auth/login', { method: 'POST', json: { email, password, tenantId } });

// ── Scenarios ───────────────────────────────────────────────────────────────

describe.skipIf(missing.length > 0)('Studio access — real gateway process', () => {
  it('secured install: the admin the installer configured can log in, everyone else cannot', async () => {
    const { port } = await startGateway({
      mode: 'secured',
      adminEmail: ADMIN_EMAIL,
      secrets: { 'gateway.bootstrap.password': ADMIN_PASSWORD, 'gateway.jwtSecret': JWT_SECRET },
    });

    expect((await login(port, ADMIN_EMAIL, ADMIN_PASSWORD)).status).toBe(200);
    expect((await login(port, ADMIN_EMAIL, 'Wrong-Password-1')).status).toBe(401);
    expect((await login(port, 'nobody@e2e.example', ADMIN_PASSWORD)).status).toBe(401);
    // Machine surfaces stay gated.
    expect((await http(port, '/metrics')).status).toBe(401);
  });

  it('secured install: readiness is green and visible to the local operator only', async () => {
    const { port } = await startGateway({
      mode: 'secured',
      adminEmail: ADMIN_EMAIL,
      secrets: { 'gateway.bootstrap.password': ADMIN_PASSWORD, 'gateway.jwtSecret': JWT_SECRET },
    });

    const local = await http(port, '/health/auth', { headers: { host: `localhost:${port}` } });
    expect(local.status).toBe(200);
    expect(JSON.parse(local.body)).toMatchObject({ ok: true, authEnabled: true, activeAdmins: 1, bootstrap: 'provisioned', issues: [] });

    // What a reverse proxy would send: nothing about readiness may leak.
    const proxied: Array<Record<string, string>> = [
      { host: 'kb-cloud.kblabs.ru' },
      { host: `localhost:${port}`, 'x-forwarded-for': '203.0.113.9' },
      { host: `localhost:${port}`, 'x-real-ip': '203.0.113.9' },
      { host: `127.0.0.1.evil.example:${port}` },
    ]
    for (const headers of proxied) {
      const denied = await http(port, '/health/auth', { headers });
      expect(denied.status, JSON.stringify(headers)).toBe(404);
      expect(denied.body).not.toContain('activeAdmins');
    }
  });

  // Regression found by the docker auth e2e: the installer wrote a default tenant into
  // the config, config beats GATEWAY_BOOTSTRAP_TENANT_ID, so an env-configured deployment
  // got its admin created in the wrong tenant and nobody could log in.
  it('secured install: the operator env decides the tenant, because the installer writes none', async () => {
    const { port } = await startGateway({
      mode: 'secured',
      adminEmail: ADMIN_EMAIL,
      env: { GATEWAY_BOOTSTRAP_TENANT_ID: 'acme' },
      secrets: { 'gateway.bootstrap.password': ADMIN_PASSWORD, 'gateway.jwtSecret': JWT_SECRET },
    });

    const readiness = JSON.parse((await http(port, '/health/auth', { headers: { host: `localhost:${port}` } })).body);
    expect(readiness).toMatchObject({ ok: true, tenantId: 'acme', activeAdmins: 1 });
    expect((await login(port, ADMIN_EMAIL, ADMIN_PASSWORD, 'acme')).status).toBe(200);
    expect((await login(port, ADMIN_EMAIL, ADMIN_PASSWORD, 'kblabs-cloud')).status).toBe(401);
  });

  it('secured install without an admin password: nobody can log in and readiness says exactly why', async () => {
    const { port } = await startGateway({ mode: 'secured', adminEmail: ADMIN_EMAIL, secrets: { 'gateway.jwtSecret': JWT_SECRET } });

    expect((await login(port, ADMIN_EMAIL, ADMIN_PASSWORD)).status).toBe(401);
    const readiness = JSON.parse((await http(port, '/health/auth', { headers: { host: `localhost:${port}` } })).body) as {
      ok: boolean; activeAdmins: number; issues: Array<{ code: string; hint: string }>;
    };
    expect(readiness.ok).toBe(false);
    expect(readiness.activeAdmins).toBe(0);
    const issue = readiness.issues.find((i) => i.code === 'no_active_admin');
    expect(issue?.hint).toContain(`kb auth reset-admin --email ${ADMIN_EMAIL}`);
  });

  it('secured install without a signing secret is flagged as forgeable', async () => {
    const { port } = await startGateway({ mode: 'secured', adminEmail: ADMIN_EMAIL, secrets: { 'gateway.bootstrap.password': ADMIN_PASSWORD } });

    const readiness = JSON.parse((await http(port, '/health/auth', { headers: { host: `localhost:${port}` } })).body) as {
      ok: boolean; issues: Array<{ code: string; severity: string }>;
    };
    // Secured binds the deployed default (all interfaces), so the public dev secret is an error.
    expect(readiness.issues).toContainEqual(expect.objectContaining({ code: 'jwt_secret_default', severity: 'error' }));
    expect(readiness.ok).toBe(false);
  });

  it('local install: no login needed, and the gateway is unreachable from other machines', async () => {
    const { port } = await startGateway({ mode: 'local' });

    expect((await http(port, '/metrics')).status).toBe(200);
    const readiness = JSON.parse((await http(port, '/health/auth', { headers: { host: `localhost:${port}` } })).body);
    expect(readiness).toMatchObject({ ok: true, authEnabled: false, issues: [] });

    expect(await reachable('127.0.0.1', port)).toBe(true);
    if (externalAddress) {
      // Bound to loopback only: the same port on the machine's LAN address is closed.
      expect(await reachable(externalAddress, port)).toBe(false);
    } else {
      console.warn('[access-modes.e2e] no external interface: skipping the non-loopback reachability check');
    }
  });

  it('secured install stays reachable on all interfaces (control for the local check)', async () => {
    if (!externalAddress) {return;}
    const { port } = await startGateway({ mode: 'secured', adminEmail: ADMIN_EMAIL, secrets: { 'gateway.bootstrap.password': ADMIN_PASSWORD, 'gateway.jwtSecret': JWT_SECRET } });
    expect(await reachable(externalAddress, port)).toBe(true);
  });
});
