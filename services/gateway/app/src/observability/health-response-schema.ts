/** Fastify serializer schema for the public observability health contract. */
export const gatewayObservabilityHealthResponseSchema = {
  type: 'object',
  required: [
    'schema', 'contractVersion', 'serviceId', 'instanceId', 'observedAt',
    'status', 'uptimeSec', 'metricsEndpoint', 'logsSource', 'capabilities', 'checks',
  ],
  properties: {
    schema: { type: 'string', const: 'kb.observability/1' },
    contractVersion: { type: 'string', const: '1.0' },
    serviceId: { type: 'string' },
    instanceId: { type: 'string' },
    observedAt: { type: 'string', format: 'date-time' },
    status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
    uptimeSec: { type: 'number', minimum: 0 },
    metricsEndpoint: { type: 'string' },
    logsSource: { type: 'string' },
    capabilities: { type: 'array', items: { type: 'string' } },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'warn', 'error'] },
          latencyMs: { type: 'number' },
          message: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
    snapshot: { type: 'object', additionalProperties: true },
    topOperations: { type: 'array', items: { type: 'object', additionalProperties: true } },
    state: { type: 'string' },
    meta: { type: 'object', additionalProperties: true },
  },
  additionalProperties: true,
} as const;
