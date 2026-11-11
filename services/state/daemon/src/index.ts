/**
 * @module @kb-labs/core-state-daemon
 * State daemon server for persistent cross-invocation state.
 */

export { StateDaemonServer } from './server';
export type { StateDaemonConfig } from './server';
export { bootstrap, setup } from './bootstrap.js';
