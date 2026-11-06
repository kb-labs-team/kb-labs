import { describe, expect, it, vi } from 'vitest';
import { noopTraceContext, noopUI } from '@kb-labs/plugin-contracts';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform';

const gatewayApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@kb-labs/sdk/gateway', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kb-labs/sdk/gateway')>()),
  gatewayApiFetch,
}));

import { authRegister } from '../commands/system/auth/auth-register.js';

describe('kb auth register', () => {
  it('uses the shared credential-origin-enforcing gateway client', async () => {
    gatewayApiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: {
      clientId: 'client-1', clientSecret: 'secret-1', hostId: 'host-1',
    } }), { status: 200 }));
    const ctx = {
      host: 'cli', requestId: 'test', pluginId: '@kb-labs/system', pluginVersion: '1.0.0', cwd: process.cwd(),
      ui: { ...noopUI, write: vi.fn(), error: vi.fn(), json: vi.fn() },
      platform: {}, runtime: { fs: {}, fetch: vi.fn(), env: vi.fn() }, api: {},
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} }, trace: noopTraceContext,
    } as unknown as PluginContextV3;

    const result = await authRegister.run(ctx, [], {
      'gateway-url': 'https://gateway-b.test', name: 'agent', 'namespace-id': 'default', json: true,
    });

    expect(result).toBe(0);
    expect(gatewayApiFetch).toHaveBeenCalledWith('https://gateway-b.test/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'agent', namespaceId: 'default' }),
    }, { gatewayUrl: 'https://gateway-b.test' });
  });

  it('rejects missing required flags without calling the Gateway client', async () => {
    gatewayApiFetch.mockReset();
    const ctx = {
      host: 'cli', requestId: 'test', pluginId: '@kb-labs/system', pluginVersion: '1.0.0', cwd: process.cwd(),
      ui: { ...noopUI, write: vi.fn(), error: vi.fn(), json: vi.fn() }, platform: {},
      runtime: { fs: {}, fetch: vi.fn(), env: vi.fn() }, api: {},
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} }, trace: noopTraceContext,
    } as unknown as PluginContextV3;
    expect(await authRegister.run(ctx, [], { name: 'agent', 'namespace-id': 'default' })).toBe(1);
    expect(gatewayApiFetch).not.toHaveBeenCalled();
  });

  it('retains the admin permission guidance when the Gateway rejects registration', async () => {
    const forbidden = createErrorEnvelope('KB_AUTH_FORBIDDEN', { details: { permission: 'MACHINE_REGISTER' } });
    gatewayApiFetch.mockRejectedValueOnce(new ErrorEnvelopeError(forbidden));
    const errors: string[] = [];
    const ctx = {
      host: 'cli', requestId: 'test', pluginId: '@kb-labs/system', pluginVersion: '1.0.0', cwd: process.cwd(),
      ui: { ...noopUI, write: vi.fn(), error: (message: string) => errors.push(message), json: vi.fn() }, platform: {},
      runtime: { fs: {}, fetch: vi.fn(), env: vi.fn() }, api: {},
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} }, trace: noopTraceContext,
    } as unknown as PluginContextV3;
    expect(await authRegister.run(ctx, [], { 'gateway-url': 'https://gateway-b.test', name: 'agent', 'namespace-id': 'default' })).toBe(1);
    expect(errors.join(' ')).toContain('MACHINE_REGISTER');
  });

  it('reports a non-auth Gateway error without printing a raw response body', async () => {
    const protocolFailure = createErrorEnvelope('KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE', {
      message: 'Gateway protocol failure during Gateway registration: expected a canonical UX result from https://gateway-b.test (HTTP 500).',
      hint: 'Run "kb-create doctor" to check the Gateway, then retry the command.',
      details: { requestStage: 'Gateway registration', gatewayUrl: 'https://gateway-b.test', httpStatus: '500' },
      correlationId: 'fixture-correlation',
    });
    gatewayApiFetch.mockRejectedValueOnce(new ErrorEnvelopeError(protocolFailure));
    const errors: string[] = [];
    const ctx = {
      host: 'cli', requestId: 'test', pluginId: '@kb-labs/system', pluginVersion: '1.0.0', cwd: process.cwd(),
      ui: { ...noopUI, write: vi.fn(), error: (message: string) => errors.push(message), json: vi.fn() }, platform: {},
      runtime: { fs: {}, fetch: vi.fn(), env: vi.fn() }, api: {},
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} }, trace: noopTraceContext,
    } as unknown as PluginContextV3;
    expect(await authRegister.run(ctx, [], { 'gateway-url': 'https://gateway-b.test', name: 'agent', 'namespace-id': 'default' })).toBe(1);
    expect(errors.join(' ')).not.toContain('internal detail');
  });

  it('preserves the catalogued auth-required envelope from the shared Gateway client', async () => {
    const authRequired = createErrorEnvelope('KB_AUTH_REQUIRED', { details: { gatewayUrl: 'https://gateway-b.test' } });
    gatewayApiFetch.mockRejectedValueOnce(new ErrorEnvelopeError(authRequired));
    const errors: string[] = [];
    const ctx = {
      host: 'cli', requestId: 'test', pluginId: '@kb-labs/system', pluginVersion: '1.0.0', cwd: process.cwd(),
      ui: { ...noopUI, write: vi.fn(), error: (message: string) => errors.push(message), json: vi.fn() }, platform: {},
      runtime: { fs: {}, fetch: vi.fn(), env: vi.fn() }, api: {},
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} }, trace: noopTraceContext,
    } as unknown as PluginContextV3;
    expect(await authRegister.run(ctx, [], { 'gateway-url': 'https://gateway-b.test', name: 'agent', 'namespace-id': 'default' })).toBe(1);
    expect(errors.join(' ')).toContain('Authentication is required');
    expect(errors.join(' ')).toContain('kb auth login --gateway-url https://gateway-b.test');
  });
});
