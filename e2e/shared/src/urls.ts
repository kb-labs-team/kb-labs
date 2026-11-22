export const GATEWAY     = process.env.GATEWAY_URL     ?? 'http://localhost:4000'
export const REST        = process.env.REST_URL        ?? 'http://localhost:5050'
// Marketplace HTTP requests must pass through Gateway so its resolved
// identity reaches the service; 5070 is intentionally not a client endpoint.
export const MARKETPLACE = process.env.MARKETPLACE_URL ?? 'http://localhost:4000'
export const REGISTRY    = process.env.REGISTRY_URL    ?? 'http://localhost:5071'
export const WORKFLOW    = process.env.WORKFLOW_URL    ?? 'http://localhost:7778'
export const STATE       = process.env.STATE_URL       ?? 'http://localhost:7777'
export const MCP         = process.env.MCP_URL         ?? 'http://localhost:7779'

// Mind has no daemon of its own — it is served by the REST API under the
// plugin route prefix. Dedicated base so specs don't hand-build the path.
export const MIND        = process.env.MIND_URL        ?? `${REST}/api/v1/plugins/mind`
