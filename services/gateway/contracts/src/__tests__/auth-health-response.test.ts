import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GatewayAuthHealthResponseSchema,
  GatewayAuthHealthIssueSchema,
  GatewayBootstrapStatusSchema,
} from '../auth-health-response.js';

const contract = JSON.parse(readFileSync(new URL('../auth-health-response.schema.json', import.meta.url), 'utf8')) as {
  properties: {
    bootstrap: { enum: string[] };
    issues: { items: { properties: { severity: { enum: string[] } } } };
  };
};
const fixture = JSON.parse(readFileSync(new URL('../../../../../core/platform/contracts/ux-result/fixtures/valid/gateway-auth-health.json', import.meta.url), 'utf8')) as unknown;

describe('Gateway auth health wire contract', () => {
  it('accepts the shared response fixture and rejects undeclared fields', () => {
    const result = fixture as { ok: boolean; data: unknown };
    expect(result.ok).toBe(true);
    expect(GatewayAuthHealthResponseSchema.parse(result.data)).toMatchObject({ bootstrap: 'exists-non-active' });
    expect(GatewayAuthHealthResponseSchema.safeParse({ ...(result.data as Record<string, unknown>), users: [] }).success).toBe(false);
  });

  it('keeps the TypeScript bootstrap enum aligned with the owning JSON schema', () => {
    expect([...GatewayBootstrapStatusSchema.options]).toEqual(contract.properties.bootstrap.enum);
    for (const status of contract.properties.bootstrap.enum) {
      expect(GatewayBootstrapStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(GatewayBootstrapStatusSchema.safeParse('unknown').success).toBe(false);
  });

  it('keeps the TypeScript issue severity enum aligned with the owning JSON schema', () => {
    expect([...GatewayAuthHealthIssueSchema.shape.severity.options]).toEqual(contract.properties.issues.items.properties.severity.enum);
  });
});
