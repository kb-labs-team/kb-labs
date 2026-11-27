export const GATEWAY     = process.env.GATEWAY_URL     ?? 'http://localhost:4000'
export const REST        = process.env.REST_URL        ?? 'http://localhost:5050'
export const REST_API_PREFIX = process.env.REST_URL?.includes('/api/v1/projects/') ? '' : '/api/v1'
export const MARKETPLACE = process.env.MARKETPLACE_URL ?? 'http://localhost:5070'
export const MARKETPLACE_DIRECT = process.env.MARKETPLACE_DIRECT_URL ?? MARKETPLACE
export const REGISTRY    = process.env.REGISTRY_URL    ?? 'http://localhost:5071'
export const WORKFLOW    = process.env.WORKFLOW_URL    ?? 'http://localhost:7778'
export const WORKFLOW_API_PREFIX = process.env.WORKFLOW_URL?.includes('/api/v1/projects/') ? '' : '/api/v1'
export const STATE       = process.env.STATE_URL       ?? 'http://localhost:7777'
export const MCP         = process.env.MCP_URL         ?? 'http://localhost:7779'

// Mind has no daemon of its own — it is served by the REST API under the
// plugin route prefix. Dedicated base so specs don't hand-build the path.
export const MIND        = process.env.MIND_URL        ?? `${REST}/api/v1/plugins/mind`
