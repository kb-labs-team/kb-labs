/**
 * Markdown reporter for release reports
 */

import type { ReleaseReport } from '../types';

export function renderMarkdown(report: ReleaseReport): string {
  const lines: string[] = [];
  
  lines.push('# 🧩 KB Labs Release Summary');
  lines.push('');
  lines.push(`**Timestamp**: ${report.ts}`);
  lines.push(`**Stage**: ${report.stage}`);
  lines.push('');

  if (report.result.ok) {
    lines.push('## ✅ Release: SUCCESS');
  } else {
    lines.push('## ❌ Release: FAILED');
  }
  
  lines.push('');

  // Checks section
  if (report.result.checks) {
    lines.push('## Quality Checks');
    lines.push('');

    for (const [id, result] of Object.entries(report.result.checks)) {
      if (!result) {continue;}
      const icon = result.ok ? '✅' : '❌';
      lines.push(`- ${icon} **${id}**: ${result.ok ? 'PASSED' : 'FAILED'}`);
      if (result.hint && !result.ok) {
        lines.push(`  - ${result.hint}`);
      }
    }
    lines.push('');
  }

  // Per-package checks
  if (report.result.checksPerPackage) {
    lines.push('## Package Quality Checks');
    lines.push('');

    for (const [pkgName, pkgChecks] of Object.entries(report.result.checksPerPackage)) {
      lines.push(`### ${pkgName}`);
      lines.push('');
      for (const [id, result] of Object.entries(pkgChecks)) {
        if (!result) {continue;}
        const icon = result.ok ? '✅' : '❌';
        lines.push(`- ${icon} **${id}**: ${result.ok ? 'PASSED' : 'FAILED'}`);
        if (result.hint && !result.ok) {
          lines.push(`  - ${result.hint}`);
        }
      }
      lines.push('');
    }
  }

  // Published packages
  if (report.result.published && report.result.published.length > 0) {
    lines.push('## 🚀 Published Packages');
    lines.push('');
    for (const pkg of report.result.published) {
      lines.push(`- ${pkg}`);
    }
    lines.push('');
  }

  // Errors
  if (report.result.errors && report.result.errors.length > 0) {
    lines.push('## ❌ Errors');
    lines.push('');
    for (const error of report.result.errors) {
      lines.push(`- ${error}`);
    }
    lines.push('');
  }

  // Timing
  lines.push(`**Duration**: ${formatTiming(report.result.timingMs)}`);
  lines.push('');

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

