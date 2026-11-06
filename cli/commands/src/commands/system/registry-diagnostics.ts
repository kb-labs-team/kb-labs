/**
 * registry:diagnostics command - Show detailed registry diagnostic report
 *
 * Runs a fresh discovery cycle and displays all diagnostic events
 * grouped by plugin, with severity, codes, and remediation hints.
 */

import { defineSystemCommand } from '@kb-labs/shared-command-kit';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import type { DiagnosticReport } from '@kb-labs/plugin-contracts';
import { getResolvedCatalog } from '../../registry/discovery-state.js';
import { formatDiagnosticReport } from '../../registry/format-diagnostic-report.js';

type DiagnosticsFlags = {
  json: { type: 'boolean'; description?: string };
  refresh: { type: 'boolean'; description?: string };
};

type DiagnosticsResult = DiagnosticReport & { status: 'healthy' | 'degraded' | 'unhealthy' };

export const registryDiagnostics = defineSystemCommand<DiagnosticsFlags, DiagnosticsResult>({
  name: 'diagnostics',
  scope: 'platform',
  jsonTest: { noSafeValidPath: 'Fresh diagnostics discovery imports every installed plugin manifest.' },
  description: 'Show registry diagnostic report',
  category: 'registry',
  examples: [],
  flags: {
    json: { type: 'boolean', description: 'Output in JSON format' },
    refresh: { type: 'boolean', description: 'Force fresh discovery (ignore cache)' },
  },
  analytics: {
    command: 'registry:diagnostics',
    startEvent: 'REGISTRY_DIAGNOSTICS_STARTED',
    finishEvent: 'REGISTRY_DIAGNOSTICS_FINISHED',
  },
  async handler(ctx, _argv, flags) {
    const cwd = getContextCwd(ctx);

    const registry = getResolvedCatalog();
    if (!registry) throw new Error('The CLI catalog was not opened during command registration.');

    if (flags.refresh) {
      await registry.refresh();
    }

    const report = registry.getDiagnostics();


    const status = report.summary.errors > 0 ? 'unhealthy' : report.summary.warnings > 0 ? 'degraded' : 'healthy';
    return { ...report, status };
  },
  formatter(result, ctx, flags) {
    const text = formatDiagnosticReport(result);
    ctx.ui.info(text);

    if (result.summary.errors > 0 || result.summary.warnings > 0) {
      ctx.ui.warn(`${result.summary.warnings} warning(s) — no blockers`);
    } else {
      ctx.ui.success('Registry is healthy — no issues found');
    }
  },
});
