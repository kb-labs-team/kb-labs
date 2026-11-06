/**
 * Corporate-style changelog template
 *
 * Professional format suitable for enterprise releases:
 * - Emoji for visual hierarchy
 * - Breaking changes prominently displayed
 * - Grouped by impact (Breaking > Features > Improvements > Fixes)
 * - Scope-based organization
 */

import type { TemplateData } from '../types';
import type { Change } from '../../types';

export const version = '1.0' as const;

export function render(data: TemplateData): string {
  const { package: pkg, breaking, changes, locale } = data;
  const lines: string[] = [];

  // Header: standard OSS format  ## [version] - YYYY-MM-DD
  const date = new Date().toISOString().split('T')[0]!;
  const reasonLabel = getReasonLabel(pkg.reason, locale);
  lines.push(`## [${pkg.next}] - ${date}`);
  lines.push('');
  lines.push(`> **${pkg.name}** ${pkg.prev} → ${pkg.next} (${reasonLabel})`);
  lines.push('');

  // Breaking changes (critical section)
  if (breaking.length > 0) {
    const breakingTitle = locale === 'ru' ? '⚠️ КРИТИЧЕСКИЕ ИЗМЕНЕНИЯ' : '⚠️ BREAKING CHANGES';
    lines.push(`### ${breakingTitle}`);
    lines.push('');
    for (const br of breaking) {
      lines.push(`- **${br.summary}**`);
      if (br.notes) {
        lines.push(`  ${br.notes}`);
      }
    }
    lines.push('');
  }

  // Features
  if (changes.feat && changes.feat.length > 0) {
    const featTitle = locale === 'ru' ? '✨ Новые возможности' : '✨ New Features';
    lines.push(`### ${featTitle}`);
    lines.push('');
    for (const feat of changes.feat) {
      lines.push(formatChangeLine(feat));
    }
    lines.push('');
  }

  // Performance improvements
  if (changes.perf && changes.perf.length > 0) {
    const perfTitle = locale === 'ru' ? '⚡ Производительность' : '⚡ Performance Improvements';
    lines.push(`### ${perfTitle}`);
    lines.push('');
    for (const perf of changes.perf) {
      lines.push(formatChangeLine(perf));
    }
    lines.push('');
  }

  // Bug fixes
  if (changes.fix && changes.fix.length > 0) {
    const fixTitle = locale === 'ru' ? '🐛 Исправления' : '🐛 Bug Fixes';
    lines.push(`### ${fixTitle}`);
    lines.push('');
    for (const fix of changes.fix) {
      lines.push(formatChangeLine(fix));
    }
    lines.push('');
  }

  // Reverts — user-visible (something was undone)
  if (changes.revert && changes.revert.length > 0) {
    const revertTitle = locale === 'ru' ? '⏪ Откаты' : '⏪ Reverts';
    lines.push(`### ${revertTitle}`);
    lines.push('');
    for (const revert of changes.revert) {
      lines.push(formatChangeLine(revert));
    }
    lines.push('');
  }

  // chore / build / ci / test / style / refactor intentionally omitted:
  // they are internal changes and not relevant to package consumers.

  return lines.join('\n').trimEnd();
}

/**
 * Format a single change line with scope and optional issue/PR refs.
 * Output: - **scope**: subject text (#123, #456)
 */
function formatChangeLine(change: Change): string {
  const scope = change.scope ? `**${change.scope}**` : '';
  const text = scope ? `${scope}: ${change.subject}` : change.subject;
  const refs = formatRefs(change);
  return refs ? `- ${text} (${refs})` : `- ${text}`;
}

/**
 * Render issue/PR refs as comma-separated links or plain numbers.
 * Uses providerLinks when available, otherwise falls back to #N notation.
 */
function formatRefs(change: Change): string {
  if (!change.refs || change.refs.length === 0) { return ''; }

  return change.refs
    .map(ref => {
      // Try to find a matching provider link for issues
      const issueLink = change.providerLinks?.issues?.find(l => l.endsWith(`/${ref.id}`));
      if (issueLink) { return `[#${ref.id}](${issueLink})`; }
      const prLink = change.providerLinks?.pr?.find(l => l.endsWith(`/${ref.id}`));
      if (prLink) { return `[#${ref.id}](${prLink})`; }
      return `#${ref.id}`;
    })
    .join(', ');
}

function getReasonLabel(reason: string, locale: 'en' | 'ru'): string {
  const labels: Record<string, Record<'en' | 'ru', string>> = {
    breaking: { en: 'major bump from breaking changes', ru: 'major из-за breaking changes' },
    feat: { en: 'minor: new features', ru: 'minor: новая функциональность' },
    fix: { en: 'patch: bug fixes', ru: 'patch: исправления' },
    perf: { en: 'patch: performance', ru: 'patch: производительность' },
    ripple: { en: 'patch: dependency update', ru: 'patch: обновление зависимостей' },
    manual: { en: 'manual', ru: 'ручное' },
  };

  return labels[reason]?.[locale] || reason;
}
