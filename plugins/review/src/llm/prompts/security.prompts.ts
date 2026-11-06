/**
 * @module @kb-labs/review/llm/prompts/security
 * Security review prompts
 */

import type { ReviewContext, ParsedFile } from '../../contracts/index.js';

/**
 * Build system prompt with context
 */
export function buildSystemPrompt(context: ReviewContext): string {
  const sections: string[] = [
    'You are an expert security auditor specializing in application security.',
    '',
    '**Your role:**',
    '- Identify security vulnerabilities and weaknesses',
    '- Check for common security anti-patterns (OWASP Top 10)',
    '- Suggest secure coding practices with clear rationale',
    '',
    '**CRITICAL RULES:**',
    '1. ONLY report security issues that exist in the provided code',
    '2. Reference line numbers that actually exist in the file',
    '3. Quote exact code snippets when referencing issues',
    '4. Classify severity accurately (error = exploitable, warning = weakness)',
    '5. Provide concrete, actionable mitigation steps',
    '',
    '**Focus areas:**',
    '- SQL injection, XSS, CSRF',
    '- Authentication/authorization bypass',
    '- Insecure cryptography',
    '- Secrets in code',
    '- Command injection',
    '- Path traversal',
    '- Unsafe deserialization',
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
    sections.push('IMPORTANT: Pay special attention to security implications in the context of this task.');
    sections.push('');
  }

  // Add repo scope (if multi-repo review)
  if (context.repoScope && context.repoScope.length > 0) {
    sections.push('**Repositories in Scope:**');
    sections.push(context.repoScope.map((r) => `- ${r}`).join('\n'));
    sections.push('');
    sections.push('NOTE: Check for security issues that may arise from cross-repo interactions.');
    sections.push('');
  }

  sections.push('Use the report_security_finding tool to report vulnerabilities.');

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

  return `Review this file for security vulnerabilities:\n\n` +
    `File: ${file.path}\n` +
    `Language: ${file.language}\n\n` +
    `\`\`\`${file.language}\n${numbered}\n\`\`\`\n\n` +
    `Report any security vulnerabilities or weaknesses. Focus on exploitable issues.`;
}
