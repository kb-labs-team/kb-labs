/**
 * Technical changelog template
 *
 * Developer-focused format with detailed information:
 * - Commit SHAs and PR links
 * - Author information
 * - File change counts
 * - All commit types (including chore, build, ci)
 * - Conventional commits grouping
 */

import type { TemplateData } from '../types';
import type { Change } from '../../types';

export const version = '1.0' as const;

export function render(data: TemplateData): string {
  const { package: pkg, breaking, changes, locale } = data;
  const lines: string[] = [];

  // Header: standard OSS format  ## [version] - YYYY-MM-DD
  const date = new Date().toISOString().split('T')[0]!;
  lines.push(`## [${pkg.next}] - ${date}`);
  lines.push('');
  lines.push(`> **${pkg.name}** \`${pkg.prev}\` → \`${pkg.next}\` (${pkg.bump})`);
  lines.push('');

  // Breaking changes with technical details
  if (breaking.length > 0) {
    const title = locale === 'ru' ? 'BREAKING CHANGES' : 'BREAKING CHANGES';
    lines.push(`### ⚠️ ${title}`);
    lines.push('');
    for (const br of breaking) {
      lines.push(`- ${br.summary}`);
      if (br.notes) {
        lines.push('');
        lines.push('  ```');
        lines.push(`  ${br.notes}`);
        lines.push('  ```');
        lines.push('');
      }
    }
    lines.push('');
  }

  // All commit types (including chore, build, ci)
  const commitTypes: Array<keyof typeof changes> = [
    'feat',
    'fix',
    'perf',
    'refactor',
    'docs',
    'test',
    'build',
    'ci',
    'chore',
    'revert',
    'style',
  ];

  for (const type of commitTypes) {
    const commits = changes[type];
    if (!commits || commits.length === 0) {continue;}

    const sectionTitle = getSectionTitle(type, locale);
    lines.push(`### ${sectionTitle}`);
    lines.push('');

    for (const commit of commits) {
      lines.push(formatTechnicalCommit(commit));
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

function formatTechnicalCommit(commit: Change): string {
  const parts: string[] = [];

  // Scope and subject
  const scopePrefix = commit.scope ? `**${commit.scope}**` : '';
  parts.push(`- ${scopePrefix}${scopePrefix ? ': ' : ''}${commit.subject}`);

  // Commit SHA
  const shortSha = commit.sha.substring(0, 7);
  parts.push(` ([${shortSha}](${commit.providerLinks?.commit || '#'}))`);

  // Author
  if (commit.author) {
    parts.push(` — @${commit.author.name}`);
  }

  // File changes count
  if (commit.filesChanged && commit.filesChanged.length > 0) {
    parts.push(` (${commit.filesChanged.length} files)`);
  }

  return parts.join('');
}

function getSectionTitle(type: string, locale: 'en' | 'ru'): string {
  const titles: Record<string, Record<'en' | 'ru', string>> = {
    feat: { en: '✨ Features', ru: '✨ Новые возможности' },
    fix: { en: '🐛 Bug Fixes', ru: '🐛 Исправления' },
    perf: { en: '⚡ Performance', ru: '⚡ Производительность' },
    refactor: { en: '♻️ Refactoring', ru: '♻️ Рефакторинг' },
    docs: { en: '📝 Documentation', ru: '📝 Документация' },
    test: { en: '✅ Tests', ru: '✅ Тесты' },
    build: { en: '🔨 Build System', ru: '🔨 Сборка' },
    ci: { en: '👷 CI/CD', ru: '👷 CI/CD' },
    chore: { en: '🔧 Chores', ru: '🔧 Обслуживание' },
    revert: { en: '⏪ Reverts', ru: '⏪ Откаты' },
    style: { en: '💄 Styles', ru: '💄 Стили' },
  };

  return titles[type]?.[locale] || type.toUpperCase();
}
