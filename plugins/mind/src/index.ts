/**
 * KB Labs Mind — plugin entry.
 *
 * Thin wiring layer: manifest, CLI commands and REST handlers. Both CLI and
 * REST call the same core facade `createMind(ctx.platform, config).verb()`.
 *
 * @module @kb-labs/mind
 */

export { manifest } from './manifest';
