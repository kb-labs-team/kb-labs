import { describe, expect, it } from 'vitest';
import type { DiagnosticReport } from '@kb-labs/plugin-contracts';
import { formatDiagnosticReport } from './format-diagnostic-report.js';

const emptyReport: DiagnosticReport = {
  events: [],
  summary: { errors: 0, warnings: 0, totalPlugins: 0, loadedPlugins: 0, failedPlugins: 0 },
  byPlugin: {},
};

describe('formatDiagnosticReport', () => {
  it('formats empty report', () => {
    expect(formatDiagnosticReport(emptyReport)).toContain('0/0 plugins loaded');
  });

  it('includes error details', () => {
    const report: DiagnosticReport = {
      events: [{ severity: 'error', code: 'MANIFEST_NOT_FOUND', message: 'manifest unavailable', context: { pluginId: '@kb-labs/broken' }, remediation: 'Rebuild the package', ts: 1 }],
      summary: { errors: 1, warnings: 0, totalPlugins: 1, loadedPlugins: 0, failedPlugins: 1 },
      byPlugin: { '@kb-labs/broken': [{ severity: 'error', code: 'MANIFEST_NOT_FOUND', message: 'manifest unavailable', context: { pluginId: '@kb-labs/broken' }, remediation: 'Rebuild the package', ts: 1 }] },
    };
    const text = formatDiagnosticReport(report);
    expect(text).toContain('ERR');
    expect(text).toContain('MANIFEST_NOT_FOUND');
    expect(text).toContain('@kb-labs/broken');
    expect(text).toContain('Fix: Rebuild the package');
  });
});
