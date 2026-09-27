/**
 * @module @kb-labs/core-discovery/diagnostics
 * Structured diagnostic collector for the discovery pipeline.
 */

import type {
  DiagnosticEvent,
  DiagnosticSeverity,
  DiagnosticCode,
  EntityKind,
} from './types.js';

/**
 * Collects diagnostic events during discovery.
 * Passed through the pipeline so every step can report issues.
 */
export class DiagnosticCollector {
  private readonly events: DiagnosticEvent[] = [];

  /** Record a diagnostic event */
  add(
    severity: DiagnosticSeverity,
    code: DiagnosticCode,
    message: string,
    opts?: {
      pluginId?: string;
      entityKind?: EntityKind;
      entityId?: string;
      filePath?: string;
      stack?: string;
      remediation?: string;
    },
  ): void {
    this.events.push({
      severity,
      code,
      message,
      context: opts
        ? {
            pluginId: opts.pluginId,
            entityKind: opts.entityKind,
            entityId: opts.entityId,
            filePath: opts.filePath,
          }
        : undefined,
      ts: Date.now(),
      stack: opts?.stack,
      remediation: opts?.remediation,
    });
  }

  /** Append already-built events (e.g. from a per-candidate collector), preserving order */
  addAll(events: readonly DiagnosticEvent[]): void {
    this.events.push(...events);
  }

  error(code: DiagnosticCode, message: string, opts?: Parameters<DiagnosticCollector['add']>[3]): void {
    this.add('error', code, message, opts);
  }

  warning(code: DiagnosticCode, message: string, opts?: Parameters<DiagnosticCollector['add']>[3]): void {
    this.add('warning', code, message, opts);
  }

  info(code: DiagnosticCode, message: string, opts?: Parameters<DiagnosticCollector['add']>[3]): void {
    this.add('info', code, message, opts);
  }

  debug(code: DiagnosticCode, message: string, opts?: Parameters<DiagnosticCollector['add']>[3]): void {
    this.add('debug', code, message, opts);
  }

  /** Return all collected events (immutable copy) */
  getEvents(): DiagnosticEvent[] {
    return [...this.events];
  }

  /** Check if any errors were collected */
  hasErrors(): boolean {
    return this.events.some(e => e.severity === 'error');
  }

  /** Count events by severity */
  countBySeverity(): Record<DiagnosticSeverity, number> {
    const counts: Record<DiagnosticSeverity, number> = {
      error: 0,
      warning: 0,
      info: 0,
      debug: 0,
    };
    for (const e of this.events) {
      counts[e.severity]++;
    }
    return counts;
  }
}
