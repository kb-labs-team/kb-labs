/**
 * TraceLoader — loads and validates NDJSON trace files for CLI commands.
 *
 * Centralizes the logic duplicated across all trace commands:
 * - taskId format validation (prevent path traversal)
 * - file existence check
 * - file size guard (prevent memory exhaustion)
 * - NDJSON parsing with graceful line-error handling
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { DetailedTraceEntry } from '@kb-labs/agent-contracts';
import { resolveRuntimeStatePath } from '@kb-labs/core-project-registry';

const TRACE_DIR_SEGMENTS = ['traces', 'incremental'] as const;

/**
 * Directory of incremental agent traces for a project. Traces are per-project
 * runtime state (ADR-0044): `<KB_HOME>/state/<projectId>/traces/incremental/`.
 */
export function resolveTraceDir(workingDir: string): string {
  return resolveRuntimeStatePath(workingDir, TRACE_DIR_SEGMENTS);
}
const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

export type TraceLoadError =
  | { kind: 'invalid_task_id'; message: string }
  | { kind: 'not_found'; taskId: string }
  | { kind: 'too_large'; sizeBytes: number }
  | { kind: 'empty'; taskId: string }
  | { kind: 'io_error'; message: string };

export type TraceLoadResult =
  | { ok: true; events: DetailedTraceEntry[]; taskId: string; filePath: string }
  | { ok: false; error: TraceLoadError };

/**
 * Load and parse a trace file by taskId.
 *
 * @param taskId - The task ID (validated against alphanumeric + hyphens/underscores)
 * @param workingDir - Project directory whose trace state directory is read (default: process.cwd())
 */
export async function loadTrace(
  taskId: string | undefined,
  workingDir: string = process.cwd()
): Promise<TraceLoadResult> {
  // 1. Presence check
  if (!taskId) {
    return { ok: false, error: { kind: 'invalid_task_id', message: 'Missing required --task-id' } };
  }

  // 2. Format validation — prevents path traversal by construction
  if (!TASK_ID_PATTERN.test(taskId)) {
    return {
      ok: false,
      error: {
        kind: 'invalid_task_id',
        message: 'Task ID must contain only alphanumeric characters, hyphens, and underscores',
      },
    };
  }

  const traceDir = resolveTraceDir(workingDir);
  const filePath = path.join(traceDir, `${taskId}.ndjson`);

  // 3. Redundant path traversal check (defence-in-depth)
  const resolvedFile = path.resolve(filePath);
  const resolvedDir = path.resolve(traceDir);
  if (!resolvedFile.startsWith(resolvedDir + path.sep) && resolvedFile !== resolvedDir) {
    return { ok: false, error: { kind: 'invalid_task_id', message: 'Path traversal detected' } };
  }

  // 4. Existence + size check
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { ok: false, error: { kind: 'not_found', taskId } };
  }

  if (stat.size > MAX_FILE_SIZE_BYTES) {
    return { ok: false, error: { kind: 'too_large', sizeBytes: stat.size } };
  }

  // 5. Read + parse NDJSON — skip malformed lines gracefully
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (e) {
    return { ok: false, error: { kind: 'io_error', message: (e as Error).message } };
  }

  const events: DetailedTraceEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) { continue; }
    try {
      events.push(JSON.parse(line) as DetailedTraceEntry);
    } catch {
      // Malformed line — skip silently (agent may have crashed mid-write)
    }
  }

  if (events.length === 0) {
    return { ok: false, error: { kind: 'empty', taskId } };
  }

  return { ok: true, events, taskId, filePath };
}

/**
 * Format a TraceLoadError into a human-readable string for CLI output.
 */
export function formatTraceLoadError(error: TraceLoadError): string {
  switch (error.kind) {
    case 'invalid_task_id': return `Invalid task ID: ${error.message}`;
    case 'not_found': return `Trace not found: ${error.taskId}`;
    case 'too_large': return `Trace file too large: ${Math.round(error.sizeBytes / 1024 / 1024)} MB (limit 100 MB)`;
    case 'empty': return `Trace file is empty: ${error.taskId}`;
    case 'io_error': return `IO error reading trace: ${error.message}`;
  }
}
