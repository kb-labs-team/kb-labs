/**
 * The gateway declares the configuration it needs to the installer in
 * `kb-create.requirements.json` (consumed by tools/kb-create's release-index
 * preparation). Nothing in the type system ties that file to the gateway's own
 * code, so this test does: a drifted env name or a path the gateway never reads
 * would otherwise ship silently and only show up as an install that "worked"
 * but configured nothing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GatewayConfigSchema } from '@kb-labs/gateway-contracts';
import { resolveAccess, resolveBootstrapTenantId } from '../access.js';

const appRoot = resolve(import.meta.dirname, '../..');

interface Requirement {
  id: string;
  path?: string;
  default?: unknown;
  secret?: boolean;
  env?: string;
  services?: string[];
  hint?: string;
}

const file = JSON.parse(readFileSync(resolve(appRoot, 'kb-create.requirements.json'), 'utf8')) as {
  schema: string;
  requirements: Requirement[];
};
const bootstrapSource = readFileSync(resolve(appRoot, 'src/bootstrap.ts'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8')) as { files: string[]; name: string };

const byId = (id: string): Requirement => {
  const found = file.requirements.find((r) => r.id === id);
  if (!found) {throw new Error(`requirement ${id} is not declared`);}
  return found;
};

/** Writes `value` at a JSON Pointer inside `target`, the way the installer materialises a path. */
const setPointer = (target: Record<string, unknown>, pointer: string, value: unknown): void => {
  const parts = pointer.split('/').slice(1);
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    cursor = (cursor[part] ??= {}) as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
};

describe('kb-create.requirements.json', () => {
  it('uses the schema the release-index tooling expects', () => {
    expect(file.schema).toBe('kb.create.requirements/v1');
  });

  it('has unique ids', () => {
    const ids = file.requirements.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is shipped in the npm package', () => {
    expect(pkg.files).toContain('kb-create.requirements.json');
  });

  it('every secret can reach the gateway and never carries a default', () => {
    for (const r of file.requirements.filter((x) => x.secret)) {
      expect(r.env, `${r.id} env`).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(r.services, `${r.id} services`).toEqual(['gateway']);
      expect(r.default, `${r.id} default`).toBeUndefined();
      expect(r.path, `${r.id} path`).toBeUndefined();
    }
  });

  it('every non-secret requirement is a JSON Pointer', () => {
    for (const r of file.requirements.filter((x) => !x.secret)) {
      expect(r.path, r.id).toMatch(/^\/gateway(\/[A-Za-z]+)+$/);
    }
  });
});

describe('the gateway really reads what it declares', () => {
  it.each(['GATEWAY_BOOTSTRAP_ADMIN_PASSWORD', 'GATEWAY_JWT_SECRET'])('reads %s from the environment', (name) => {
    expect(file.requirements.some((r) => r.env === name)).toBe(true);
    expect(bootstrapSource).toContain(`process.env.${name}`);
  });

  it('every declared secret env is one the gateway reads (no drifted names)', () => {
    for (const r of file.requirements.filter((x) => x.secret)) {
      expect(bootstrapSource, `${r.id} → ${r.env}`).toContain(`process.env.${r.env}`);
    }
  });

  it('materialised paths land where the gateway config schema reads them', () => {
    const config: Record<string, unknown> = {};
    // Defaults as the installer writes them, plus samples for the value-less requirements.
    const samples: Record<string, unknown> = { 'gateway.bootstrap.adminEmail': 'admin@example.com', 'gateway.bootstrap.tenantId': 'acme' };
    for (const r of file.requirements.filter((x) => !x.secret)) {
      const value = samples[r.id] ?? r.default;
      expect(value, `${r.id} needs a default or a sample`).toBeDefined();
      setPointer(config, r.path!, value);
    }
    const parsed = GatewayConfigSchema.parse((config as { gateway: unknown }).gateway);

    expect(parsed.access).toEqual({ mode: 'secured' });
    expect(parsed.auth?.bootstrap?.adminEmail).toBe('admin@example.com');
    expect(parsed.auth?.bootstrap?.tenantId).toBe('acme');
  });

  it('the default install (defaults only, no answers) keeps login required', () => {
    const config: Record<string, unknown> = {};
    for (const r of file.requirements.filter((x) => !x.secret && x.default !== undefined)) {
      setPointer(config, r.path!, r.default);
    }
    const parsed = GatewayConfigSchema.parse((config as { gateway: unknown }).gateway);
    expect(resolveAccess(parsed).authEnabled).toBe(true);
  });

  // Regression found by the docker auth e2e: a default here was written into
  // kb.config, config beats GATEWAY_BOOTSTRAP_TENANT_ID, so every env-configured
  // deployment got its admin created in the wrong tenant and nobody could log in.
  it('declares NO default for anything the operator can also set through the env', () => {
    expect(byId('gateway.bootstrap.tenantId').default).toBeUndefined();
    expect(resolveBootstrapTenantId({}, { GATEWAY_BOOTSTRAP_TENANT_ID: 'kb-cloud' })).toBe('kb-cloud');
  });

  it('a default install writes no tenant, so the operator env decides', () => {
    const config: Record<string, unknown> = {};
    for (const r of file.requirements.filter((x) => !x.secret && x.default !== undefined)) {
      setPointer(config, r.path!, r.default);
    }
    const parsed = GatewayConfigSchema.parse((config as { gateway: unknown }).gateway);
    expect(resolveBootstrapTenantId(parsed, { GATEWAY_BOOTSTRAP_TENANT_ID: 'kb-cloud' })).toBe('kb-cloud');
  });

  it('a local choice yields a config that disables login even though auth.bootstrap is present', () => {
    const config: Record<string, unknown> = {};
    setPointer(config, byId('gateway.access.mode').path!, 'local');
    setPointer(config, byId('gateway.bootstrap.tenantId').path!, 'acme'); // an auth object must not re-enable login
    const parsed = GatewayConfigSchema.parse((config as { gateway: unknown }).gateway);
    expect(resolveAccess(parsed)).toEqual({ authEnabled: false, bindHost: '127.0.0.1' });
  });
});
