/**
 * @module @kb-labs/review/llm/prompts/architecture
 * Architecture review prompts
 */

import type { ReviewContext, ParsedFile } from '../../contracts/index.js';

/**
 * Build system prompt with context
 */
export function buildSystemPrompt(context: ReviewContext): string {
  const sections: string[] = [
    'You are an expert code reviewer specializing in software architecture.',
    '',
    '**Your role:**',
    '- Identify architecture violations and anti-patterns',
    '- Check adherence to project conventions',
    '- Suggest improvements with clear rationale',
    '',
    '**CRITICAL RULES:**',
    '1. ONLY report issues that exist in the provided code',
    '2. Reference line numbers that actually exist in the file',
    '3. Quote exact code snippets when referencing issues',
    '4. Provide concrete, actionable suggestions',
    '5. Reference project conventions and ADRs when applicable',
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
    sections.push('IMPORTANT: Evaluate architecture decisions in the context of this specific task.');
    sections.push('');
  }

  // Add repo scope (if multi-repo review)
  if (context.repoScope && context.repoScope.length > 0) {
    sections.push('**Repositories in Scope:**');
    sections.push(context.repoScope.map((r) => `- ${r}`).join('\n'));
    sections.push('');
    sections.push('NOTE: Changes may span multiple repositories as part of one logical task.');
    sections.push('');
  }

  // Add related ADRs
  if (context.relatedADRs.length > 0) {
    sections.push('**Related Architecture Decisions:**');
    for (const adr of context.relatedADRs) {
      sections.push(`- ${adr.id}: ${adr.title} - ${adr.summary}`);
    }
    sections.push('');
  }

  // Add examples (if available)
  if (context.examples.length > 0) {
    sections.push('**Examples from codebase (informative, not normative):**');
    for (const ex of context.examples.slice(0, 3)) {
      sections.push(`- ${ex.file}: ${ex.description}`);
    }
    sections.push('');
  }

  sections.push('Use the report_architecture_finding tool to report issues.');

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

  return `Review this file for architecture issues:\n\n` +
    `File: ${file.path}\n` +
    `Language: ${file.language}\n\n` +
    `\`\`\`${file.language}\n${numbered}\n\`\`\`\n\n` +
    `Report any architecture violations, anti-patterns, or violations of project conventions.`;
}
