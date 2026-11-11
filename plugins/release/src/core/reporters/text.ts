/**
 * Text reporter for release reports
 */

import type { ReleaseReport } from '../types';

export function renderText(report: ReleaseReport): string {
  const lines: string[] = [];
  
  lines.push('[release] ' + (report.result.ok ? 'OK' : 'FAILED'));
  lines.push('');

  // Checks
  if (report.result.checks) {
    for (const [id, result] of Object.entries(report.result.checks)) {
      if (!result) {continue;}
      lines.push(`[${id}] ${result.ok ? 'pass' : 'fail'}`);
      if (result.hint && !result.ok) {
        lines.push(`  ${result.hint}`);
      }
    }
    lines.push('');
  }

  // Per-package checks
  if (report.result.checksPerPackage) {
    for (const [pkgName, pkgChecks] of Object.entries(report.result.checksPerPackage)) {
      lines.push(`[${pkgName}]`);
      for (const [id, result] of Object.entries(pkgChecks)) {
        if (!result) {continue;}
        lines.push(`  [${id}] ${result.ok ? 'pass' : 'fail'}`);
        if (result.hint && !result.ok) {
          lines.push(`    ${result.hint}`);
        }
      }
    }
    lines.push('');
  }

  // Published
  if (report.result.published && report.result.published.length > 0) {
    lines.push('[published] ' + report.result.published.length + ' package(s)');
    for (const pkg of report.result.published) {
      lines.push(`  ${pkg}`);
    }
    lines.push('');
  }

  // Errors
  if (report.result.errors && report.result.errors.length > 0) {
    lines.push('[errors]');
    for (const error of report.result.errors) {
      lines.push(`  ${error}`);
    }
    lines.push('');
  }

  lines.push(`[timing] ${formatTiming(report.result.timingMs)}`);

  return lines.join('\n');
}

function formatTiming(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${(ms / 60000).toFixed(1)}m`;
}

