import { describe, it, expect } from 'vitest';
import {
  AuthConfigSchema,
  GatewayConfigSchema,
  HostRegistrationSchema,
  HostDescriptorSchema,
  AuthContextSchema,
  HelloMessageSchema,
  CallMessageSchema,
  ErrorMessageSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../index.js';

describe('GatewayConfigSchema', () => {
  it('parses valid config with defaults', () => {
    const result = GatewayConfigSchema.parse({});
    expect(result.port).toBe(4000);
    expect(result.upstreams).toEqual({});
  });

  it('parses config with upstreams', () => {
    const result = GatewayConfigSchema.parse({
      port: 4001,
      upstreams: {
        ui: { serviceId: 'rest-api', prefix: '/api/ui' },
      },
    });
    expect(result.port).toBe(4001);
    expect(result.upstreams['ui']!.serviceId).toBe('rest-api');
    expect(result.upstreams['ui']!.prefix).toBe('/api/ui');
  });

  it('rejects upstream without serviceId', () => {
    expect(() =>
      GatewayConfigSchema.parse({
        upstreams: { bad: { serviceId: '', prefix: '/api/bad' } },
      }),
    ).toThrow();
  });

  it('rejects upstream prefix without leading slash', () => {
    expect(() =>
      GatewayConfigSchema.parse({
        upstreams: { bad: { serviceId: 'svc', prefix: 'api/no-slash' } },
      }),
    ).toThrow();
  });

});

describe('AuthConfigSchema.providers (ADR-0020 DD-4)', () => {
  it('omitting providers leaves it undefined', () => {
    const cfg = AuthConfigSchema.parse({ bootstrap: { tenantId: 't1' } });
    expect(cfg.providers).toBeUndefined();
  });

  it('parses a providers map keyed by instance id, each requiring a type', () => {
    const cfg = AuthConfigSchema.parse({
      bootstrap: { tenantId: 't1' },
      providers: {
        'email-password': { type: 'email-password' },
        corp: { type: 'oidc' },
      },
    });
    expect(cfg.providers?.['email-password']?.type).toBe('email-password');
    expect(cfg.providers?.['corp']?.type).toBe('oidc');
  });

  it('passthrough keeps provider-specific keys for the provider schema to validate', () => {
    const cfg = AuthConfigSchema.parse({
      bootstrap: { tenantId: 't1' },
      providers: {
        corp: { type: 'oidc', issuer: 'https://idp.example', clientId: 'abc' },
      },
    });
    const corp = cfg.providers?.['corp'] as Record<string, unknown>;
    expect(corp['issuer']).toBe('https://idp.example');
    expect(corp['clientId']).toBe('abc');
  });

  it('rejects a provider entry without a type', () => {
    expect(() =>
      AuthConfigSchema.parse({
        bootstrap: { tenantId: 't1' },
        providers: { broken: { issuer: 'https://x' } },
      }),
    ).toThrow();
  });
});

describe('HostRegistrationSchema', () => {
  const valid = {
    name: 'laptop',
    namespaceId: 'ns-1',
    capabilities: ['filesystem', 'git'],
    workspacePaths: ['/home/user/projects'],
  };

  it('parses valid registration', () => {
    const result = HostRegistrationSchema.parse(valid);
    expect(result.name).toBe('laptop');
    expect(result.capabilities).toContain('filesystem');
  });

  it('accepts all valid capability values', () => {
    for (const cap of ['filesystem', 'git', 'editor-context'] as const) {
      expect(() => HostRegistrationSchema.parse({ ...valid, capabilities: [cap] })).not.toThrow();
    }
  });

  it('rejects invalid capability value', () => {
    expect(() =>
      HostRegistrationSchema.parse({ ...valid, capabilities: ['database'] }),
    ).toThrow();
  });

  it('requires name', () => {
    expect(() => HostRegistrationSchema.parse({ ...valid, name: undefined })).toThrow();
  });

  it('requires namespaceId', () => {
    expect(() => HostRegistrationSchema.parse({ ...valid, namespaceId: undefined })).toThrow();
  });

  it('allows empty capabilities array', () => {
    expect(() => HostRegistrationSchema.parse({ ...valid, capabilities: [] })).not.toThrow();
  });
});

describe('HostDescriptorSchema', () => {
  const valid = {
    hostId: 'host-uuid',
    name: 'laptop',
    namespaceId: 'ns-1',
    capabilities: ['filesystem'],
    status: 'online',
    lastSeen: Date.now(),
    connections: ['conn-1'],
  };

  it('parses valid descriptor', () => {
    const result = HostDescriptorSchema.parse(valid);
    expect(result.status).toBe('online');
  });

  it('accepts all status values', () => {
    for (const status of ['online', 'offline', 'degraded'] as const) {
      expect(() => HostDescriptorSchema.parse({ ...valid, status })).not.toThrow();
    }
  });

  it('rejects invalid status', () => {
    expect(() => HostDescriptorSchema.parse({ ...valid, status: 'unknown' })).toThrow();
  });
});

describe('AuthContextSchema', () => {
  it('parses user auth context', () => {
    const result = AuthContextSchema.parse({
      type: 'user',
      userId: 'user-1',
      namespaceId: 'ns-1',
      tier: 'pro',
      permissions: ['read', 'write'],
    });
    expect(result.type).toBe('user');
    expect(result.tier).toBe('pro');
  });

  it('rejects invalid tier', () => {
    expect(() =>
      AuthContextSchema.parse({
        type: 'user', userId: 'u', namespaceId: 'ns', tier: 'platinum', permissions: [],
      }),
    ).toThrow();
  });

  it('accepts all type values', () => {
    for (const type of ['user', 'cli', 'machine'] as const) {
      expect(() =>
        AuthContextSchema.parse({ type, userId: 'u', namespaceId: 'ns', tier: 'free', permissions: [] }),
      ).not.toThrow();
    }
  });
});

describe('HelloMessageSchema', () => {
  it('parses minimal hello', () => {
    const result = HelloMessageSchema.parse({
      type: 'hello',
      protocolVersion: '1.0',
      agentVersion: '0.1.0',
    });
    expect(result.type).toBe('hello');
    expect(result.hostId).toBeUndefined();
  });

  it('parses hello with reconnect hostId', () => {
    const result = HelloMessageSchema.parse({
      type: 'hello',
      protocolVersion: '1.0',
      agentVersion: '0.1.0',
      hostId: 'host-uuid',
    });
    expect(result.hostId).toBe('host-uuid');
  });

  it('rejects wrong type literal', () => {
    expect(() =>
      HelloMessageSchema.parse({ type: 'world', protocolVersion: '1.0', agentVersion: '0.1.0' }),
    ).toThrow();
  });
});

describe('CallMessageSchema', () => {
  it('parses valid call', () => {
    const result = CallMessageSchema.parse({
      type: 'call',
      requestId: 'req-1',
      adapter: 'fs',
      method: 'readFile',
      args: ['/tmp/test.txt'],
      trace: { traceId: 'tr-1', spanId: 'sp-1' },
    });
    expect(result.adapter).toBe('fs');
    expect(result.args).toEqual(['/tmp/test.txt']);
    expect(result.bulk).toBeUndefined();
  });

  it('parses bulk call', () => {
    const result = CallMessageSchema.parse({
      type: 'call',
      requestId: 'req-2',
      adapter: 'fs',
      method: 'writeFile',
      args: [],
      bulk: true,
      trace: { traceId: 'tr-2', spanId: 'sp-2' },
    });
    expect(result.bulk).toBe(true);
  });

  it('requires trace field', () => {
    expect(() =>
      CallMessageSchema.parse({ type: 'call', requestId: 'r', adapter: 'fs', method: 'm', args: [] }),
    ).toThrow();
  });
});

describe('ErrorMessageSchema', () => {
  it('parses valid error', () => {
    const result = ErrorMessageSchema.parse({
      type: 'error',
      requestId: 'req-1',
      error: { code: 'FS_NOT_FOUND', message: 'File not found', retryable: false },
    });
    expect(result.error.code).toBe('FS_NOT_FOUND');
    expect(result.error.retryable).toBe(false);
  });
});

describe('SUPPORTED_PROTOCOL_VERSIONS', () => {
  it('contains 1.0', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('1.0');
  });
});

describe('GatewayConfigSchema.access / AuthConfigSchema.enabled', () => {
  it('access is optional and its mode is a closed enum', () => {
    expect(GatewayConfigSchema.parse({}).access).toBeUndefined();
    expect(GatewayConfigSchema.parse({ access: { mode: 'local' } }).access).toEqual({ mode: 'local' });
    expect(() => GatewayConfigSchema.parse({ access: { mode: 'nope' } })).toThrow();
    expect(() => GatewayConfigSchema.parse({ access: {} })).toThrow();
  });

  it('auth.enabled is NOT defaulted: mentioning auth must not read as an explicit "enabled: true"', () => {
    expect(AuthConfigSchema.parse({ bootstrap: { tenantId: 't' } }).enabled).toBeUndefined();
    expect(AuthConfigSchema.parse({ enabled: false }).enabled).toBe(false);
    expect(AuthConfigSchema.parse({ enabled: true }).enabled).toBe(true);
  });
});

describe('AuthConfigSchema.bootstrap.tenantId', () => {
  it('is optional: the gateway falls back to the env, then its default', () => {
    expect(AuthConfigSchema.parse({ bootstrap: { adminEmail: 'admin@example.com' } }).bootstrap?.tenantId).toBeUndefined();
    expect(AuthConfigSchema.parse({ bootstrap: { tenantId: 'acme' } }).bootstrap?.tenantId).toBe('acme');
    expect(() => AuthConfigSchema.parse({ bootstrap: { tenantId: '' } })).toThrow();
  });
});
