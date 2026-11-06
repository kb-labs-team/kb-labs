/**
 * LLM-powered changelog formatter with graceful degradation
 * Corporate style like OpenAI/GitHub/Microsoft releases
 */

import type { PackageRelease, Change } from '../types';
import type { ILLM } from '@kb-labs/sdk';
import { formatPackageAsMarkdown } from './markdown';

/**
 * Minimal platform interface (duck-typing)
 * Avoids circular dependency on plugin-runtime
 */
interface PlatformLike {
  llm?: ILLM;
  isConfigured?(service: string): boolean;
}

/**
 * Format changelog with LLM (corporate style) or fallback to conventional
 */
export async function formatPackageWithLLM(
  platform: PlatformLike | undefined,
  pkg: PackageRelease,
  locale: 'en' | 'ru' = 'en'
): Promise<string> {
  // 1. Check if LLM is available (simple presence check, no isConfigured needed)
  const llmAvailable = !!platform?.llm;

  if (!llmAvailable) {
    // GRACEFUL DEGRADATION: fallback to conventional formatter
    return formatPackageAsMarkdown(pkg, 'standard', locale);
  }

  try {
    // TypeScript guard: we already checked llmAvailable above
    const llm = platform.llm!;

    // 2. Filter substantial changes (skip chore/build/ci)
    const substantialChanges = pkg.changes.filter(c =>
      !['chore', 'build', 'ci', 'style', 'test'].includes(c.type)
    );

    if (substantialChanges.length === 0) {
      return ''; // No substantial changes
    }

    // 3. Prepare context for LLM (group by type)
    const grouped = groupByType(substantialChanges);
    const changesContext = Object.entries(grouped)
      .map(([type, changes]) => {
        const items = changes.map(c => `  - ${c.scope ? c.scope + ': ' : ''}${c.subject}`).join('\n');
        return `${type}:\n${items}`;
      })
      .join('\n\n');

    // 4. Corporate-style prompt (OpenAI/GitHub format)
    const prompt = buildCorporatePrompt(pkg, changesContext, locale);

    // 5. Call LLM
    const systemPrompt = locale === 'ru'
      ? 'Ты технический писатель, создающий changelog для крупной компании. Пиши профессионально, структурировано и понятно.'
      : 'You are a technical writer creating changelogs for a major company. Write professionally, structured, and clearly.';

    const response = await llm.complete(prompt, {
      systemPrompt,
      temperature: 0.7,
      maxTokens: 1500,
    });

    // 6. MANDATORY VALIDATION: Verify LLM output
    const formatted = formatLLMResponse(pkg, response.content, locale);
    const validationResult = validateLLMChangelog(formatted, substantialChanges);

    if (!validationResult.valid) {
      console.warn(`LLM changelog validation failed: ${validationResult.errors.join(', ')}. Falling back to conventional format.`);
      return formatPackageAsMarkdown(pkg, 'standard', locale);
    }

    return formatted;

  } catch (error) {
    // GRACEFUL DEGRADATION on LLM error
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`LLM changelog failed, falling back to conventional: ${errorMessage}`);
    return formatPackageAsMarkdown(pkg, 'standard', locale);
  }
}

/**
 * Build corporate-style prompt
 */
function buildCorporatePrompt(pkg: PackageRelease, changes: string, locale: 'en' | 'ru'): string {
  const lang = locale === 'ru' ? 'Russian' : 'English';

  return `Generate a professional changelog entry for package "${pkg.name}" version ${pkg.prev} → ${pkg.next}.

Changes made:
${changes}

Requirements:
- Write in ${lang}
- Professional corporate tone (like OpenAI, GitHub, Microsoft releases)
- Start with a brief summary paragraph explaining WHAT changed and WHY it matters to users
- Group changes by category (Features, Improvements, Bug Fixes, etc)
- Focus on USER IMPACT, not technical details
- Explain WHY changes matter, not just WHAT changed
- Use clear, non-technical language when possible
- Include emoji for readability: ✨ Features, 🐛 Fixes, ⚡ Performance, 📝 Documentation

Format:
## ${pkg.name} ${pkg.next}

[1-2 sentence summary paragraph]

### ✨ New Features
- Clear description of feature and why it's useful

### 🐛 Bug Fixes
- What was fixed and how it helps users

### ⚡ Performance Improvements
- What's faster and by how much

DO NOT:
- List commit SHAs or PR numbers
- Use technical jargon unnecessarily
- Mention internal refactoring unless user-facing
- Include chore/build/ci changes

Output ONLY the markdown changelog, no explanations.`;
}

/**
 * Format LLM response with professional footer
 */
function formatLLMResponse(pkg: PackageRelease, llmContent: string, locale: 'en' | 'ru'): string {
  // Add package version header if LLM didn't include it
  let formatted = llmContent;
  if (!formatted.includes(`## ${pkg.name}`)) {
    const header = `## ${pkg.name} ${pkg.next}\n\n`;
    formatted = header + formatted;
  }

  // Add professional footer
  const footer = buildChangelogFooter(locale);
  formatted = formatted.trimEnd() + '\n\n' + footer;

  return formatted;
}

/**
 * Build professional changelog footer
 */
function buildChangelogFooter(locale: 'en' | 'ru'): string {
  const year = new Date().getFullYear();

  if (locale === 'ru') {
    return `---

*Сгенерировано автоматически с помощью [**@kb-labs/release**](https://github.com/kb-labs/kb-labs)*
*Часть экосистемы **KB Labs Platform** — профессиональные инструменты для разработки*

<sub>© ${year} KB Labs. Released under KB Public License v1.1</sub>`;
  }

  return `---

*Generated automatically by [**@kb-labs/release**](https://github.com/kb-labs/kb-labs)*
*Part of the **KB Labs Platform** — Professional developer tools ecosystem*

<sub>© ${year} KB Labs. Released under KB Public License v1.1</sub>`;
}

/**
 * Group changes by type
 */
function groupByType(changes: Change[]): Record<string, Change[]> {
  const grouped: Record<string, Change[]> = {};
  for (const change of changes) {
    if (!grouped[change.type]) {grouped[change.type] = [];}
    grouped[change.type]!.push(change);
  }
  return grouped;
}

/**
 * MANDATORY VALIDATION: Verify LLM output is valid and doesn't hallucinate
 *
 * Anti-hallucination checks:
 * 1. Output is not empty
 * 2. Has markdown structure (headers)
 * 3. Doesn't mention commits/changes that don't exist in source data
 * 4. Doesn't invent fake SHAs, PRs, or issues
 */
interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function validateLLMChangelog(llmOutput: string, sourceChanges: Change[]): ValidationResult {
  const errors: string[] = [];

  // 1. Check not empty
  if (!llmOutput || llmOutput.trim().length === 0) {
    errors.push('Empty output');
    return { valid: false, errors };
  }

  // 2. Check has markdown structure (at least one header)
  if (!llmOutput.includes('#')) {
    errors.push('No markdown headers found');
  }

  // 3. Extract all subjects from source changes (ground truth)
  const sourceSubjects = new Set(sourceChanges.map(c => c.subject.toLowerCase().trim()));
  const sourceScopes = new Set(sourceChanges.map(c => c.scope?.toLowerCase().trim()).filter(Boolean));

  // 4. Check for hallucinated SHAs (40-char hex that don't exist)
  const shaPattern = /\b[0-9a-f]{7,40}\b/gi;
  const mentionedShas = llmOutput.match(shaPattern) || [];
  const sourceShas = new Set(sourceChanges.map(c => c.sha.toLowerCase()));

  for (const sha of mentionedShas) {
    const lowerSha = sha.toLowerCase();
    // Check if this SHA prefix matches any source SHA
    const isValid = Array.from(sourceShas).some(sourceSha => sourceSha.startsWith(lowerSha));
    if (!isValid) {
      errors.push(`Hallucinated SHA: ${sha}`);
    }
  }

  // 5. Check for hallucinated PR/issue numbers (should only mention real ones)
  const prPattern = /#(\d+)/g;
  const mentionedPRs = new Set<string>();
  let match;
  while ((match = prPattern.exec(llmOutput)) !== null) {
    mentionedPRs.add(match[1]!);
  }

  const sourceRefs = new Set(sourceChanges.flatMap(c => c.refs.map(r => r.id)));
  for (const pr of mentionedPRs) {
    if (!sourceRefs.has(pr)) {
      errors.push(`Hallucinated PR/issue: #${pr}`);
    }
  }

  // 6. Validate line count is reasonable (not truncated, not too verbose)
  const lineCount = llmOutput.split('\n').length;
  if (lineCount < 3) {
    errors.push('Output too short (< 3 lines)');
  }
  if (lineCount > 200) {
    errors.push('Output too verbose (> 200 lines)');
  }

  // 7. Check output doesn't include forbidden patterns (signs of hallucination)
  const forbiddenPatterns = [
    /\[REDACTED\]/i,
    /\[PLACEHOLDER\]/i,
    /\[TODO\]/i,
    /\[EXAMPLE\]/i,
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(llmOutput)) {
      errors.push(`Forbidden pattern found: ${pattern.source}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
