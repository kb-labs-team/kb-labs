import { describe, expect, it } from 'vitest';
import type { ServiceManifest } from '@kb-labs/plugin-contracts';
import { collectProjectServiceOperations } from '../service-operations.js';

const manifest: ServiceManifest = {
  schema: 'kb.service/1', id: 'workflow', name: 'Workflow', version: '1.0.0',
  runtime: { entry: 'dist/index.js', port: 1, healthCheck: '/health' },
  projectApi: { serviceId: 'workflow', rewritePrefix: '/api/v1' },
  commands: [{
    kind: 'service', name: 'workflow cron enable', description: 'Enable cron',
    scope: 'project', category: 'workflow', jsonTest: {}, flags: {},
    invocation: { operationId: 'workflow.cron.set-enabled', inputs: [], values: { enabled: true } },
    route: { method: 'POST', path: '/crons/{id}/enable', mount: 'project-api' },
  }],
};
const operation = { serviceId: 'workflow', operationId: 'workflow.cron.set-enabled', execute: async () => undefined };

describe('collectProjectServiceOperations', () => {
  it('accepts only a unique operation declared and owned by its module', () => {
    expect(collectProjectServiceOperations([{ manifest, operations: [operation] }])).toEqual([operation]);
    expect(() => collectProjectServiceOperations([{ manifest, operations: [{ ...operation, serviceId: 'mcp' }] }]))
      .toThrow(/expected "workflow"/);
    expect(() => collectProjectServiceOperations([{ manifest, operations: [] }])).toThrow(/without registering it/);
    expect(() => collectProjectServiceOperations([{ manifest, operations: [operation, operation] }])).toThrow(/Duplicate/);
    expect(() => collectProjectServiceOperations([{ manifest, operations: [{ ...operation, operationId: 'other' }] }]))
      .toThrow(/undeclared operation/);
  });
});
