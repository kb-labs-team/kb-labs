export const GATEWAY     = process.env.GATEWAY_URL     ?? 'http://localhost:4000'
export const REST        = process.env.REST_URL        ?? 'http://localhost:5050'
// Marketplace HTTP requests must pass through Gateway; 5070 is service-only.
export const MARKETPLACE = process.env.MARKETPLACE_URL ?? 'http://localhost:4000'
export const WORKFLOW    = process.env.WORKFLOW_URL    ?? 'http://localhost:7778'
export const STATE       = process.env.STATE_URL       ?? 'http://localhost:7777'
