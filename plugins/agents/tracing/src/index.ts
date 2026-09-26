/**
 * @kb-labs/agent-tracing
 *
 * Tracing infrastructure for KB Labs Agents.
 *
 * - IncrementalTraceWriter  — crash-safe NDJSON append-only tracer
 * - FileTracer              — in-memory tracer (simple, for tests/dev)
 * - TraceLoader             — load + validate NDJSON traces for CLI commands
 * - trace-helpers           — factory functions for all trace event types
 * - privacy-redactor        — secret and path redaction for trace events
 */

export { IncrementalTraceWriter, DEFAULT_TRACE_CONFIG } from './incremental-trace-writer.js';
export type { TraceConfig, TraceIndex } from './incremental-trace-writer.js';

export { FileTracer } from './file-tracer.js';

export { loadTrace, formatTraceLoadError, resolveTraceDir } from './trace-loader.js';
export type { TraceLoadResult, TraceLoadError } from './trace-loader.js';

export * from './trace-helpers.js';
export * from './privacy-redactor.js';
