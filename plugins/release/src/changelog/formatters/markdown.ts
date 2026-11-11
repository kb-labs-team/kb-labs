/**
 * Markdown changelog formatter with i18n support and rendering levels
 */

import type { PackageRelease, Change, CommitType } from '../types';

export type RenderingLevel = 'compact' | 'standard' | 'detailed';

/**
 * Format package release as markdown
 */
export function formatPackageAsMarkdown(
  pkg: PackageRelease,
  level: RenderingLevel = 'standard',
  locale: 'en' | 'ru' = 'en'
): string {
  const lines: string[] = [];
  
  // Header: ## [version] - YYYY-MM-DD (package name as subheading if not obvious from context)
  const date = new Date().toISOString().split('T')[0]!;
  lines.push(`## [${pkg.next}] - ${date}`);
  lines.push('');

  // Version bump context (subtle, not a full redundant header)
  const reasonLabel = formatReasonLabel(pkg.reason, locale);
  lines.push(`> **${pkg.name}** ${pkg.prev} → ${pkg.next} (${reasonLabel})`);
  lines.push('');

  // Breaking changes
  if (pkg.breaking && pkg.breaking.length > 0) {
    lines.push('### ' + t('breaking_changes', locale));
    lines.push('');
    for (const breaking of pkg.breaking) {
      lines.push(`- **${breaking.summary}**`);
      if (breaking.notes) {
        lines.push(`  ${breaking.notes}`);
      }
    }
    lines.push('');
  }

  // Group changes by type
  const groupedChanges = groupChangesByType(pkg.changes);

  // Render by type groups
  for (const [type, changes] of Object.entries(groupedChanges)) {
    if (changes.length === 0) {continue;}

    const sectionTitle = formatSectionTitle(type as CommitType, locale);
    lines.push(`### ${sectionTitle}`);
    lines.push('');

    for (const change of changes) {
      lines.push(formatChangeLine(change, level));
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Format change line based on rendering level
 */
function formatChangeLine(change: Change, level: RenderingLevel): string {
  const bullet = '-';
  let line = `${bullet} **${change.scope || 'global'}**: ${change.subject}`;
  
  if (level === 'compact') {
    return line;
  }
  
  // Standard: add links
  const links: string[] = [];
  
  if (change.providerLinks?.commit) {
    links.push(`[${change.sha.substring(0, 7)}](${change.providerLinks.commit})`);
  }
  
  if (change.providerLinks?.pr && change.providerLinks.pr.length > 0) {
    for (const prLink of change.providerLinks.pr) {
      const match = prLink.match(/[^/]+$/);
      links.push(`[${match && match[0] ? match[0] : 'PR'}](${prLink})`);
    }
  }
  
  if (links.length > 0) {
    line += ` (${links.join(', ')})`;
  }
  
  // Detailed: add authors, file counts
  if (level === 'detailed') {
    const details: string[] = [];
    if (change.author) {
      details.push(`@${change.author.name}`);
    }
    if (change.coAuthors && change.coAuthors.length > 0) {
      details.push(...change.coAuthors.map(a => `@${a.name}`));
    }
    if (change.filesChanged && change.filesChanged.length > 0) {
      details.push(`${change.filesChanged.length} files`);
    }
    if (details.length > 0) {
      line += ` — ${details.join(', ')}`;
    }
  }
  
  return line;
}

/**
 * Group changes by type
 */
function groupChangesByType(changes: Change[]): Record<string, Change[]> {
  const grouped: Record<string, Change[]> = {};
  
  for (const change of changes) {
    const type = change.type;
    if (!grouped[type]) {
      grouped[type] = [];
    }
    grouped[type].push(change);
  }
  
  return grouped;
}

/**
 * Format section title based on locale
 */
function formatSectionTitle(type: CommitType, locale: 'en' | 'ru'): string {
  const titles: Record<string, Record<'en' | 'ru', string>> = {
    feat: { en: 'Features', ru: 'Новые возможности' },
    fix: { en: 'Bug Fixes', ru: 'Исправления' },
    perf: { en: 'Performance', ru: 'Производительность' },
    refactor: { en: 'Refactoring', ru: 'Рефакторинг' },
    docs: { en: 'Documentation', ru: 'Документация' },
    build: { en: 'Build', ru: 'Сборка' },
    ci: { en: 'CI/CD', ru: 'CI/CD' },
    test: { en: 'Tests', ru: 'Тесты' },
    chore: { en: 'Chores', ru: 'Обслуживание' },
    revert: { en: 'Reverts', ru: 'Откаты' },
  };
  
  return titles[type]?.[locale] || type;
}

/**
 * Format reason as a short human label
 */
function formatReasonLabel(reason: string, locale: 'en' | 'ru'): string {
  const labels: Record<string, Record<'en' | 'ru', string>> = {
    breaking: { en: 'major — breaking changes', ru: 'major — критические изменения' },
    feat: { en: 'minor — new features', ru: 'minor — новая функциональность' },
    fix: { en: 'patch — bug fixes', ru: 'patch — исправления' },
    perf: { en: 'patch — performance', ru: 'patch — производительность' },
    ripple: { en: 'patch — dependency update', ru: 'patch — обновление зависимостей' },
    manual: { en: 'manual', ru: 'ручное' },
  };
  return labels[reason]?.[locale] ?? reason;
}

/**
 * Simple translation helper
 */
function t(key: string, locale: 'en' | 'ru'): string {
  const translations: Record<string, Record<'en' | 'ru', string>> = {
    breaking_changes: { en: 'BREAKING CHANGES', ru: 'КРИТИЧЕСКИЕ ИЗМЕНЕНИЯ' },
  };

  return translations[key]?.[locale] ?? key;
}

/**
 * Format a lockstep monorepo release as a single consolidated changelog entry.
 *
 * All packages share the same nextVersion, so instead of N separate ## sections
 * we produce one version header, a packages table, and merged change lists.
 *
 * Example output:
 * ## [1.2.0] - 2026-03-01
 *
 * **17 packages** bumped to v1.2.0
 *
 * | Package | Previous | Bump |
 * ...
 *
 * ### ✨ Features
 * - **scope** (pkg): subject
 */
export function formatLockstepChangelog(
  packages: PackageRelease[],
  version: string,
  locale: 'en' | 'ru' = 'en',
): string {
  const lines: string[] = [];
  const date = new Date().toISOString().split('T')[0]!;

  // Header
  lines.push(`## [${version}] - ${date}`);
  lines.push('');

  const pkgCount = packages.length;
  const pkgWord = locale === 'ru' ? 'пакетов' : pkgCount === 1 ? 'package' : 'packages';
  lines.push(`**${pkgCount} ${pkgWord}** bumped to v${version}`);
  lines.push('');

  // Packages table — only show packages that actually changed (bump !== 'none')
  const changed = packages.filter(p => p.bump !== 'none');
  if (changed.length > 0) {
    const colPkg = locale === 'ru' ? 'Пакет' : 'Package';
    const colPrev = locale === 'ru' ? 'Предыдущая' : 'Previous';
    const colBump = locale === 'ru' ? 'Тип' : 'Bump';
    lines.push(`| ${colPkg} | ${colPrev} | ${colBump} |`);
    lines.push(`|---------|----------|------|`);
    for (const pkg of changed) {
      lines.push(`| \`${pkg.name}\` | ${pkg.prev} | ${pkg.bump} |`);
    }
    lines.push('');
  }

  // Breaking changes (all packages combined, deduplicated by summary)
  const allBreaking = deduplicateBySummary(
    packages.flatMap(p => (p.breaking || []).map(b => ({ ...b, _pkg: p.name })))
  );
  if (allBreaking.length > 0) {
    lines.push(`### ${t('breaking_changes', locale)}`);
    lines.push('');
    for (const b of allBreaking) {
      lines.push(`- **${b.summary}**`);
      if (b.notes) {lines.push(`  ${b.notes}`);}
    }
    lines.push('');
  }

  // Collect all non-chore changes, deduplicated by SHA
  const seenShas = new Set<string>();
  const allChanges: Array<{ change: Change; packageName: string }> = [];

  for (const pkg of packages) {
    for (const change of pkg.changes) {
      if (seenShas.has(change.sha)) {continue;}
      if (['chore', 'build', 'ci', 'style', 'test'].includes(change.type)) {continue;}
      seenShas.add(change.sha);
      allChanges.push({ change, packageName: pkg.name });
    }
  }

  // Group by type
  const grouped = new Map<CommitType, Array<{ change: Change; packageName: string }>>();
  for (const item of allChanges) {
    const type = item.change.type;
    if (!grouped.has(type)) {grouped.set(type, []);}
    grouped.get(type)!.push(item);
  }

  // Render grouped changes
  const typeOrder: CommitType[] = ['feat', 'fix', 'perf', 'refactor', 'docs', 'revert'];
  for (const type of typeOrder) {
    const items = grouped.get(type);
    if (!items || items.length === 0) {continue;}

    lines.push(`### ${formatSectionTitle(type, locale)}`);
    lines.push('');
    for (const { change, packageName } of items) {
      const scopePart = change.scope ? `**${change.scope}**` : '**global**';
      // Show package name in parentheses when scope doesn't identify the package
      const pkgHint = change.scope === packageName || allChanges.filter(i => i.change.sha === change.sha).length === 1
        ? ''
        : ` *(${packageName})*`;
      lines.push(`- ${scopePart}: ${change.subject}${pkgHint}`);
    }
    lines.push('');
  }

  if (allChanges.length === 0) {
    const noChanges = locale === 'ru' ? 'Без функциональных изменений.' : 'No functional changes.';
    lines.push(`*${noChanges}*`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function deduplicateBySummary<T extends { summary: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.summary)) {return false;}
    seen.add(item.summary);
    return true;
  });
}
