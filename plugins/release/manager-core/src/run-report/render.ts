/**
 * Renderers for ReleaseRunReport: Markdown (artifact / CI summary) and
 * compact plain-text lines (terminal box).
 */

import type { CheckFailure, ReleaseRunReport } from './report';

function fmtDuration(ms?: number): string {
  if (ms === undefined) { return '-'; }
  if (ms < 1000) { return `${ms}ms`; }
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderRunReportMarkdown(report: ReleaseRunReport): string {
  const lines: string[] = [];
  lines.push('# Release run report');
  lines.push('');
  lines.push(`- Result: **${report.ok ? 'PASSED' : 'FAILED'}**`);
  if (report.flow) { lines.push(`- Flow: \`${report.flow}\``); }
  if (report.scope) { lines.push(`- Scope: \`${report.scope}\``); }
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push('');

  lines.push('## Stages');
  lines.push('');
  lines.push('| Stage | Status | Duration | Log |');
  lines.push('|---|---|---|---|');
  for (const s of report.stages) {
    lines.push(`| ${s.stage} | ${s.status} | ${fmtDuration(s.durationMs)} | ${s.log ? cell(s.log) : '-'} |`);
  }
  lines.push('');

  lines.push('## Checks');
  lines.push('');
  lines.push('| Check | Status | Duration | Failing packages |');
  lines.push('|---|---|---|---|');
  for (const c of report.checks) {
    lines.push(`| ${cell(c.id)} | ${c.status} | ${fmtDuration(c.durationMs)} | ${c.failedPackages} |`);
  }
  lines.push('');

  if (report.skipped.length > 0) {
    lines.push('## Skipped');
    lines.push('');
    for (const s of report.skipped) {
      lines.push(`- ${cell(s.checkId)}${s.packagePath ? ` @ ${cell(s.packagePath)}` : ''}: ${cell(s.reason)}`);
    }
    lines.push('');
  }

  if (report.failures.length === 0) {
    lines.push('No failures.');
    lines.push('');
    return lines.join('\n');
  }

  const classes = Object.entries(report.summary.byClassification).map(([k, v]) => `${k}: ${v}`).join(', ');
  lines.push('## Failures');
  lines.push('');
  lines.push(`${report.summary.blockingFailures} blocking, ${report.summary.optionalFailures} optional (${classes}).`);
  lines.push('');

  for (const group of report.byPackage) {
    lines.push(`### ${group.package}`);
    lines.push('');
    for (const f of group.failures) {
      lines.push(`#### ${f.checkId}${f.optional ? ' (optional)' : ''}`);
      lines.push('');
      lines.push(`- Classification: **${f.classification}** (\`${f.error.code}\`, rule \`${f.rule}\`)`);
      lines.push(`- Root cause: ${f.rootCause}`);
      lines.push(`- Hint: ${f.hint}`);
      lines.push(`- Next: \`${f.resumeCommand}\``);
      if (f.outputExcerpt) {
        lines.push('');
        lines.push(f.timedOut ? 'Partial output before the kill:' : 'Output (tail):');
        lines.push('');
        lines.push('```');
        lines.push(f.outputExcerpt);
        lines.push('```');
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

/** One block of lines per failure, for the terminal box. */
export function renderFailureLines(failures: CheckFailure[]): string[] {
  const lines: string[] = [];
  for (const f of failures) {
    lines.push(`${f.checkId} @ ${f.package}${f.optional ? ' (optional)' : ''}`);
    lines.push(`  [${f.classification}] ${f.error.code}`);
    lines.push(`  Cause: ${f.rootCause}`);
    lines.push(`  Hint: ${f.hint}`);
  }
  if (failures.length > 0) {
    lines.push(`Next: ${failures[0]!.resumeCommand}`);
  }
  return lines;
}
