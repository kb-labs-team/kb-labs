/**
 * @module @kb-labs/core-registry/diagnostics/reporter
 * Build a DiagnosticReport from raw diagnostic events.
 */

import type { DiagnosticEvent, DiagnosticReport } from '@kb-labs/plugin-contracts';

export function buildDiagnosticReport(
  events: DiagnosticEvent[],
  totalPlugins: number,
  loadedPlugins: number,
): DiagnosticReport {
  const byPlugin: Record<string, DiagnosticEvent[]> = {};
  let errors = 0;
  let warnings = 0;

  for (const event of events) {
    if (event.severity === 'error') {errors++;}
    if (event.severity === 'warning') {warnings++;}

    const key = event.context?.pluginId ?? '__global__';
    if (!byPlugin[key]) {byPlugin[key] = [];}
    byPlugin[key]!.push(event);
  }

  return {
    events,
    summary: {
      errors,
      warnings,
      totalPlugins,
      loadedPlugins,
      failedPlugins: totalPlugins - loadedPlugins,
    },
    byPlugin,
  };
}
