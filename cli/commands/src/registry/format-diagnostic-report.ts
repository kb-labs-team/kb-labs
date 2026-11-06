import type { DiagnosticEvent, DiagnosticReport } from '@kb-labs/plugin-contracts';

function formatEventLines(events: DiagnosticEvent[], lines: string[]): void {
  for (const evt of events) {
    const prefix = evt.severity === 'error' ? 'ERR' : evt.severity === 'warning' ? 'WRN' : evt.severity.toUpperCase().slice(0, 3);
    lines.push(`  ${prefix} ${evt.code}: ${evt.message}`);
    if (evt.remediation) {lines.push(`      Fix: ${evt.remediation}`);}
  }
}

export function formatDiagnosticReport(report: DiagnosticReport): string {
  const lines: string[] = [];
  const { summary } = report;

  lines.push(`Registry Diagnostics: ${summary.loadedPlugins}/${summary.totalPlugins} plugins loaded`);
  if (summary.errors > 0) {lines.push(`  ${summary.errors} error(s)`);}
  if (summary.warnings > 0) {lines.push(`  ${summary.warnings} warning(s)`);}
  lines.push('');

  for (const [pluginId, events] of Object.entries(report.byPlugin)) {
    const label = pluginId === '__global__' ? 'Global' : pluginId;
    lines.push(`[${label}]`);
    formatEventLines(events, lines);
    lines.push('');
  }

  return lines.join('\n');
}
