/**
 * AI-Enhanced Corporate Changelog Template
 *
 * When `groups` are configured (via changelog.groups in kb.config.json):
 *   - Renders sections by group (e.g. "Core & SDK", "Gateway & API", "Adapters")
 *   - Each group gets an LLM-enhanced summary of its commits
 *   - Commits not matching any group go to "Other"
 *
 * Without groups config (fallback):
 *   - Renders sections by commit type (feat, fix, perf, revert)
 *   - Same LLM enhancement per section
 *
 * Graceful degradation if LLM unavailable — falls back to basic bullet list.
 */

import type { TemplateData, PlatformLike, ChangelogGroup } from '../types';
import type { Change } from '../../types';

export const version = '1.0' as const;

export async function render(data: TemplateData, platform?: PlatformLike): Promise<string> {
  const { package: pkg, breaking, changes, locale, groups } = data;
  const lines: string[] = [];

  // Header: standard OSS format  ## [version] - YYYY-MM-DD
  const date = new Date().toISOString().split('T')[0]!;
  const reasonLabel = getReasonLabel(pkg.reason, locale);
  lines.push(`## [${pkg.next}] - ${date}`);
  lines.push('');
  lines.push(`> **${pkg.name}** ${pkg.prev} → ${pkg.next} (${reasonLabel})`);
  lines.push('');

  // Breaking changes always first (critical, always shown regardless of grouping)
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

  // Flatten all user-visible commits (feat, fix, perf, revert)
  const allChanges: Change[] = [
    ...(changes.feat ?? []),
    ...(changes.fix ?? []),
    ...(changes.perf ?? []),
    ...(changes.revert ?? []),
  ];

  if (allChanges.length === 0) {
    return lines.join('\n').trimEnd();
  }

  if (groups && groups.length > 0) {
    // ── Group mode: render by configured groups ──
    const rendered = await renderByGroups(allChanges, groups, platform, locale);
    lines.push(...rendered);
  } else {
    // ── Fallback: render by commit type ──
    const rendered = await renderByType(changes, platform, locale);
    lines.push(...rendered);
  }

  return lines.join('\n').trimEnd();
}

// ─── Group-based rendering ────────────────────────────────────────────────────

async function renderByGroups(
  allChanges: Change[],
  groups: ChangelogGroup[],
  platform: PlatformLike | undefined,
  locale: 'en' | 'ru'
): Promise<string[]> {
  const lines: string[] = [];

  // Assign each commit to the first matching group
  const grouped = new Map<string, Change[]>();
  const ungrouped: Change[] = [];

  for (const change of allChanges) {
    const scope = change.scope ?? '';
    const matchedGroup = groups.find(g => scopeMatchesGroup(scope, g));
    if (matchedGroup) {
      const key = matchedGroup.title;
      if (!grouped.has(key)) {grouped.set(key, []);}
      grouped.get(key)!.push(change);
    } else {
      ungrouped.push(change);
    }
  }

  // Render each group in config order (skip empty groups)
  for (const group of groups) {
    const commits = grouped.get(group.title);
    if (!commits || commits.length === 0) {continue;}

    const prefix = group.emoji ? `${group.emoji} ` : '';
    lines.push(`### ${prefix}${group.title}`);
    lines.push('');
    const text = await enhanceGroup(platform, commits, group.title, locale);
    lines.push(text);
    lines.push('');
  }

  // Ungrouped commits go to "Other" section
  if (ungrouped.length > 0) {
    const otherTitle = locale === 'ru' ? '### 🔧 Прочее' : '### 🔧 Other';
    lines.push(otherTitle);
    lines.push('');
    const text = await enhanceGroup(platform, ungrouped, 'other', locale);
    lines.push(text);
    lines.push('');
  }

  return lines;
}

/**
 * Match a commit scope to a group.
 * "adapters" in scopes matches scope "adapters-redis" (prefix match).
 * Exact match takes priority.
 */
function scopeMatchesGroup(scope: string, group: ChangelogGroup): boolean {
  if (!scope) {return false;}
  return group.scopes.some(s => scope === s || scope.startsWith(`${s}-`) || scope.startsWith(`${s}/`));
}

// ─── Type-based rendering (fallback) ─────────────────────────────────────────

async function renderByType(
  changes: Partial<Record<string, Change[]>>,
  platform: PlatformLike | undefined,
  locale: 'en' | 'ru'
): Promise<string[]> {
  const lines: string[] = [];

  if (changes.feat && changes.feat.length > 0) {
    const title = locale === 'ru' ? '✨ Новые возможности' : '✨ New Features';
    lines.push(`### ${title}`);
    lines.push('');
    lines.push(await enhanceGroup(platform, changes.feat, 'features', locale));
    lines.push('');
  }

  if (changes.perf && changes.perf.length > 0) {
    const title = locale === 'ru' ? '⚡ Производительность' : '⚡ Performance Improvements';
    lines.push(`### ${title}`);
    lines.push('');
    lines.push(await enhanceGroup(platform, changes.perf, 'performance', locale));
    lines.push('');
  }

  if (changes.fix && changes.fix.length > 0) {
    const title = locale === 'ru' ? '🐛 Исправления' : '🐛 Bug Fixes';
    lines.push(`### ${title}`);
    lines.push('');
    lines.push(await enhanceGroup(platform, changes.fix, 'fixes', locale));
    lines.push('');
  }

  if (changes.revert && changes.revert.length > 0) {
    const title = locale === 'ru' ? '⏪ Откаты' : '⏪ Reverts';
    lines.push(`### ${title}`);
    lines.push('');
    lines.push(await enhanceGroup(platform, changes.revert, 'reverts', locale));
    lines.push('');
  }

  return lines;
}

// ─── LLM enhancement ─────────────────────────────────────────────────────────

/**
 * Per-call budget for a single group's LLM enhancement. Deliberately scoped
 * to ONE platform.llm.complete() call, not the whole multi-group render —
 * renderByGroups()/renderByType() await these sequentially (up to ~6 groups
 * for a large monorepo release), so a render-level timeout scales badly with
 * package/group count. A slow group degrades to formatBasicGroup() instead
 * of failing the entire changelog.
 */
const LLM_GROUP_TIMEOUT_MS = 20_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

async function enhanceGroup(
  platform: PlatformLike | undefined,
  commits: Change[],
  groupLabel: string,
  locale: 'en' | 'ru'
): Promise<string> {
  if (!platform?.llm) {
    return formatBasicGroup(commits);
  }

  try {
    const commitsContext = commits.map(c => ({
      scope: c.scope || 'general',
      subject: c.subject,
      body: c.body,
      refs: c.refs && c.refs.length > 0 ? c.refs.map(r => `#${r.id}`).join(', ') : undefined,
    }));

    const prompt = buildEnhancementPrompt(commitsContext, groupLabel, locale);

    const response = await withTimeout(
      platform.llm.complete(prompt, { temperature: 0.7, maxTokens: 500 }),
      LLM_GROUP_TIMEOUT_MS,
      `LLM enhancement for group "${groupLabel}"`,
    );

    await platform?.analytics?.track?.('changelog.llm.enhanced', {
      groupLabel,
      locale,
      commitsCount: commits.length,
      contentLength: response.content.length,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.promptTokens + response.usage.completionTokens,
      model: response.model,
    });

    const enhanced = response.content.trim();
    if (enhanced.length === 0) {
      return formatBasicGroup(commits);
    }

    return enhanced;
  } catch {
    return formatBasicGroup(commits);
  }
}

function buildEnhancementPrompt(
  commits: Array<{ scope: string; subject: string; body?: string; refs?: string }>,
  groupLabel: string,
  locale: 'en' | 'ru'
): string {
  const lang = locale === 'ru' ? 'Russian' : 'English';

  const commitsText = commits
    .map(c => `- ${c.scope}: ${c.subject}${c.refs ? ` [refs: ${c.refs}]` : ''}`)
    .join('\n');

  return `You are writing a professional changelog for a software release.

Section: ${groupLabel}
Language: ${lang}

Commits in this section:
${commitsText}

Task: Write a clear, user-focused description for each commit as a markdown list.
- Explain WHY each change matters to users, not just WHAT changed
- Use clear, non-technical language when possible
- Keep each item to 1-2 sentences
- Start with scope in **bold** if present
- If a commit has refs like [refs: #123], append them at end of the line as (#123)

Example output format:
- **api**: Enables async request handling, improving throughput under high load (#42)
- **logger**: Fixes memory leak that occurred after 1000+ log entries

Write ONLY the markdown list, no explanations or meta-commentary.`;
}

function formatBasicGroup(commits: Change[]): string {
  return commits
    .map(c => {
      const scope = c.scope ? `**${c.scope}**` : '';
      const text = scope ? `${scope}: ${c.subject}` : c.subject;
      const refs = formatRefs(c);
      return refs ? `- ${text} (${refs})` : `- ${text}`;
    })
    .join('\n');
}

function formatRefs(change: Change): string {
  if (!change.refs || change.refs.length === 0) { return ''; }

  return change.refs
    .map(ref => {
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
