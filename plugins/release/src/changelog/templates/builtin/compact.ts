/**
 * Compact changelog template
 *
 * Minimal format for quick release notes:
 * - One-line per change
 * - No emoji or decorations
 * - Essential information only
 * - Perfect for automated consumption
 */

import type { TemplateData } from '../types';

export const version = '1.0' as const;

export function render(data: TemplateData): string {
  const { package: pkg, breaking, changes } = data;
  const lines: string[] = [];

  // Header: standard OSS format
  const date = new Date().toISOString().split('T')[0]!;
  lines.push(`## [${pkg.next}] - ${date}`);
  lines.push(`> **${pkg.name}**`);
  lines.push('');

  // Breaking changes (compact list)
  if (breaking.length > 0) {
    lines.push('**BREAKING:**');
    for (const br of breaking) {
      lines.push(`- ${br.summary}`);
    }
    lines.push('');
  }

  // Features (compact)
  if (changes.feat && changes.feat.length > 0) {
    for (const feat of changes.feat) {
      const prefix = feat.scope ? `${feat.scope}: ` : '';
      lines.push(`- feat: ${prefix}${feat.subject}`);
    }
  }

  // Fixes (compact)
  if (changes.fix && changes.fix.length > 0) {
    for (const fix of changes.fix) {
      const prefix = fix.scope ? `${fix.scope}: ` : '';
      lines.push(`- fix: ${prefix}${fix.subject}`);
    }
  }

  // Performance (compact)
  if (changes.perf && changes.perf.length > 0) {
    for (const perf of changes.perf) {
      const prefix = perf.scope ? `${perf.scope}: ` : '';
      lines.push(`- perf: ${prefix}${perf.subject}`);
    }
  }

  return lines.join('\n').trim();
}
