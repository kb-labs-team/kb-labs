/**
 * @module @kb-labs/review/llm/prompts/naming
 * Naming conventions review prompts
 */

import type { ReviewContext, ParsedFile } from '../../contracts/index.js';

/**
 * Build system prompt with context
 */
export function buildSystemPrompt(context: ReviewContext): string {
  const sections: string[] = [
    'You are a code quality expert specializing in naming conventions and code clarity.',
    '',
    '**Your role:**',
    '- Check adherence to naming conventions',
    '- Identify unclear or misleading names',
    '- Suggest improvements for readability',
    '',
    '**CRITICAL RULES:**',
    '1. ONLY report names that violate project conventions',
    '2. Reference line numbers that actually exist',
    '3. Quote exact names when referencing issues',
    '4. Provide concrete, better alternatives',
    '5. Focus on clarity and consistency',
    '',
    '**Common issues:**',
    '- Inconsistent casing (camelCase vs snake_case)',
    '- Abbreviations without clear meaning',
    '- Generic names (data, temp, obj)',
    '- Misleading names (opposite of actual behavior)',
    '',
  ];

  // Add all project conventions
  for (const [category, content] of Object.entries(context.conventions)) {
    sections.push(`**Project Conventions (${category}):**`);
    sections.push(content);
    sections.push('');
  }

  // Add task context (if reviewing a specific task)
  if (context.taskContext) {
    sections.push('**Current Task Context:**');
    sections.push(context.taskContext);
    sections.push('');
    sections.push('IMPORTANT: Consider naming in the context of this specific task and its domain.');
    sections.push('');
  }

  // Add repo scope (if multi-repo review)
  if (context.repoScope && context.repoScope.length > 0) {
    sections.push('**Repositories in Scope:**');
    sections.push(context.repoScope.map((r) => `- ${r}`).join('\n'));
    sections.push('');
    sections.push('NOTE: Ensure naming consistency across these repositories.');
    sections.push('');
  }

  sections.push('Use the report_naming_finding tool to report naming issues.');

  return sections.join('\n');
}

/**
 * Build user prompt for file analysis
 */
export function analyzeFile(file: ParsedFile): string {
  const lines = file.content.split('\n');
  const numbered = lines
    .map((line, idx) => `${idx + 1}: ${line}`)
    .join('\n');

  return `Review this file for naming convention issues:\n\n` +
    `File: ${file.path}\n` +
    `Language: ${file.language}\n\n` +
    `\`\`\`${file.language}\n${numbered}\n\`\`\`\n\n` +
    `Report naming issues that reduce code clarity or violate conventions.`;
}
