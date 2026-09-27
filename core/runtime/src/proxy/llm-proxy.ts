/**
 * Backward-compatible runtime entry point for the shared IPC LLM proxy.
 * Routing metadata is defined by the platform contract and implemented in
 * core-ipc so both runtime proxy construction paths expose the same behavior.
 */
export { LLMProxy } from '@kb-labs/core-ipc';
