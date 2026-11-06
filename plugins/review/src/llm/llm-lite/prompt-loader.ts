/**
 * @module @kb-labs/review/llm/llm-lite/prompt-loader
 * Load prompts and rules from .kb/review/ directory.
 *
 * Reads markdown files and builds context for LLM prompts.
 */

import type { ReviewConfig } from '../../contracts/index.js';
import { useConfig } from '@kb-labs/sdk';
import { readdir, readFile, access } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Rule frontmatter metadata
 */
export interface RuleFrontmatter {
  /** Unique rule ID (e.g., "security/no-eval") */
  id: string;
  /** Default severity for this rule */
  severity?: 'blocker' | 'high' | 'medium' | 'low' | 'info';
  /** Rule type: 'positive' (report these issues) or 'negative' (do NOT report these) */
  type?: 'positive' | 'negative';
}

/**
 * Loaded rule content
 */
export interface RuleContent {
  /** Rule category (directory name) */
  category: string;
  /** Rule name (filename without extension) */
  name: string;
  /** Rule content (markdown without frontmatter) */
  content: string;
  /** Rule ID from frontmatter (e.g., "security/no-eval") */
  id?: string;
  /** Default severity from frontmatter */
  severity?: 'blocker' | 'high' | 'medium' | 'low' | 'info';
  /** Rule type: 'positive' (report these) or 'negative' (do NOT report these) */
  type?: 'positive' | 'negative';
}

/**
 * Loaded prompts
 */
export interface LoadedPrompts {
  /** System prompt (from prompts/system.md or default) */
  system: string;
  /** Task prompt (from prompts/task.md or default) */
  task: string;
  /** Rules content by category */
  rules: Record<string, RuleContent[]>;
  /** All rules as formatted string for prompt */
  rulesContext: string;
  /** Set of valid rule IDs for validation */
  ruleIds: Set<string>;
}

/**
 * Default system prompt (fallback if no file exists)
 */
const DEFAULT_SYSTEM_PROMPT = `You are a security-focused code auditor. Your job is to find every real vulnerability and bug in the code — think like an attacker reading this before exploiting it.

## Process

1. Fetch diffs for ALL files using get_diffs() before drawing any conclusions
2. Read every file thoroughly — don't stop at the first finding
3. After analyzing all files, report ALL findings in a single report_findings() call

## What to Look For

Hunt for anything that could be exploited or cause harm in production:
- Injection vectors: SQL, shell, template, path traversal, SSRF
- Secrets and credentials hardcoded anywhere in the code
- Broken authentication or authorization logic
- Unsafe cryptography (weak algorithms, insecure randomness, plaintext storage)
- Unvalidated input flowing into dangerous sinks
- Logic errors that change program behavior in unexpected ways
- Resource leaks and error paths that expose internals

## Rules

- Report every distinct issue you find — don't summarize multiple bugs into one
- Each finding needs a line number and a code snippet from the diff
- Skip style, formatting, and hypothetical "could be better" suggestions
- Language doesn't matter: Python, PHP, JS, Go, Ruby — audit everything the same way

## Severity

### blocker
Directly exploitable: injection, RCE, auth bypass, exposed secrets, data exfiltration

### high
Real bug with production impact: broken logic, data corruption, significant information leak

### medium
Potential issue requiring specific conditions: missing validation, unsafe default, weak crypto choice

### low
Minor risk: informational leak in errors, missing rate limit, suboptimal but not dangerous`;

/**
 * Default task prompt (fallback if no file exists)
 */
const DEFAULT_TASK_PROMPT = `## Your Task

You have a list of changed files. Do the following in order:

1. Call get_diffs() for ALL files at once — fetch everything before analyzing anything
2. Read every diff carefully and list every vulnerability or bug you spot
3. Do NOT call report_findings() until you have gone through every single file
4. Call report_findings() once with the complete list of everything you found

Don't triage or prioritize — report every real issue, from hardcoded passwords to SQL injections to broken logic. A complete report is better than a conservative one.`;

/**
 * Load all prompts and rules from .kb/review/
 */
export async function loadPrompts(cwd: string): Promise<LoadedPrompts> {
  const config = await useConfig<ReviewConfig>('review');

  const kbDir = path.join(cwd, '.kb');
  const rulesDir = path.join(kbDir, config?.rulesDir ?? 'review/rules');
  const promptsDir = path.join(kbDir, config?.promptsDir ?? 'review/prompts');

  // Load system and task prompts
  const system = await loadPromptFile(promptsDir, 'system.md', DEFAULT_SYSTEM_PROMPT);
  const task = await loadPromptFile(promptsDir, 'task.md', DEFAULT_TASK_PROMPT);

  // Load rules by category
  const rules = await loadRules(rulesDir);

  // Collect all rule IDs for validation
  const ruleIds = new Set<string>();
  for (const categoryRules of Object.values(rules)) {
    for (const rule of categoryRules) {
      if (rule.id) {
        ruleIds.add(rule.id);
      }
    }
  }

  // Format rules as context string
  const rulesContext = formatRulesContext(rules);

  return { system, task, rules, rulesContext, ruleIds };
}

/**
 * Load a single prompt file with fallback
 */
async function loadPromptFile(dir: string, filename: string, fallback: string): Promise<string> {
  try {
    const filePath = path.join(dir, filename);
    await access(filePath);
    const content = await readFile(filePath, 'utf-8');
    return content.trim();
  } catch {
    return fallback;
  }
}

/**
 * Load all rules from rules directory
 */
async function loadRules(rulesDir: string): Promise<Record<string, RuleContent[]>> {
  const rules: Record<string, RuleContent[]> = {};

  try {
    await access(rulesDir);
  } catch {
    return rules;
  }

  // Read category directories
  const entries = await readdir(rulesDir, { withFileTypes: true });
  const categories = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));

  for (const categoryDir of categories) {
    const category = categoryDir.name;

    // Path traversal protection: skip names with path separators or '..'
    if (category.includes('..') || category.includes(path.sep) || category.includes('/')) {
      continue;
    }

    const categoryPath = path.join(rulesDir, category);

    // Read rule files in category
    // eslint-disable-next-line no-await-in-loop -- Sequential directory reading
    const ruleFiles = await readdir(categoryPath, { withFileTypes: true });
    const mdFiles = ruleFiles.filter(f => f.isFile() && f.name.endsWith('.md'));

    rules[category] = [];

    for (const ruleFile of mdFiles) {
      // Path traversal protection: skip names with path separators or '..'
      if (ruleFile.name.includes('..') || ruleFile.name.includes(path.sep) || ruleFile.name.includes('/')) {
        continue;
      }

      const ruleName = ruleFile.name.replace('.md', '');
      const rulePath = path.join(categoryPath, ruleFile.name);

      try {
        // eslint-disable-next-line no-await-in-loop -- Sequential file reading for rule loading
        const rawContent = await readFile(rulePath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(rawContent);

        rules[category].push({
          category,
          name: ruleName,
          content: body.trim(),
          id: frontmatter?.id,
          severity: frontmatter?.severity,
          type: frontmatter?.type ?? 'positive', // Default to positive rule
        });
      } catch {
        // Skip unreadable files
      }
    }
  }

  return rules;
}

/**
 * Format rules as context string for prompt
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Complex multi-level categorization and formatting of rules into structured prompt sections
function formatRulesContext(rules: Record<string, RuleContent[]>): string {
  const positiveSections: string[] = [];
  const negativeSections: string[] = [];

  for (const [category, categoryRules] of Object.entries(rules)) {
    if (categoryRules.length === 0) {
      continue;
    }

    // Separate positive and negative rules
    const positiveRules = categoryRules.filter(r => r.type !== 'negative');
    const negativeRules = categoryRules.filter(r => r.type === 'negative');

    // Format positive rules (issues to report)
    if (positiveRules.length > 0) {
      positiveSections.push(`## ${capitalize(category)} Rules\n`);
      for (const rule of positiveRules) {
        if (rule.id) {
          positiveSections.push(`### Rule: ${rule.id}\n`);
        }
        positiveSections.push(rule.content);
        positiveSections.push('');
      }
    }

    // Format negative rules (patterns NOT to report)
    if (negativeRules.length > 0) {
      for (const rule of negativeRules) {
        if (rule.id) {
          negativeSections.push(`### ${rule.id}\n`);
        }
        negativeSections.push(rule.content);
        negativeSections.push('');
      }
    }
  }

  if (positiveSections.length === 0 && negativeSections.length === 0) {
    return '';
  }

  // Collect positive rule IDs for the explicit list
  const allRuleIds: string[] = [];
  for (const categoryRules of Object.values(rules)) {
    for (const rule of categoryRules) {
      if (rule.id && rule.type !== 'negative') {
        allRuleIds.push(rule.id);
      }
    }
  }

  const ruleIdList = allRuleIds.length > 0
    ? `\n\n**Available Rule IDs:** ${allRuleIds.join(', ')}`
    : '';

  // Build false positive prevention section
  const falsePositiveSection = negativeSections.length > 0
    ? `\n\n## FALSE POSITIVE PREVENTION (Do NOT Report These)\n\n**CRITICAL:** Before reporting any issue, check if it matches a pattern below. If it does, DO NOT REPORT IT.\n\n${negativeSections.join('\n')}`
    : '';

  return `# Project-Specific Rules (MANDATORY)

## CRITICAL: You MUST Use Rule IDs

When reporting findings, you MUST check if the issue matches one of these project rules and use the exact ruleId:
${ruleIdList}

### How to Report:

1. **If issue matches a rule** → Use the EXACT ruleId from the list above
   Example: \`"ruleId": "security/path-traversal"\` or \`"ruleId": "consistency/validation-logic"\`

2. **If issue does NOT match any rule** → Use \`"ruleId": null\`

### Examples:

- Path traversal issue → \`"ruleId": "security/path-traversal"\`
- Input validation issue → \`"ruleId": "security/input-validation"\`
- Inconsistent validation logic → \`"ruleId": "consistency/validation-logic"\`
- Dead code → \`"ruleId": "architecture/dead-code-paths"\`
- Some other issue not in rules → \`"ruleId": null\`

## Project Rules

${positiveSections.join('\n')}${falsePositiveSection}`;
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Parse YAML frontmatter from markdown content
 *
 * Frontmatter format:
 * ---
 * id: category/rule-name
 * severity: medium
 * ---
 */
function parseFrontmatter(content: string): { frontmatter: RuleFrontmatter | null; body: string } {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n*/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: null, body: content };
  }

  const yamlContent = match[1] ?? '';
  const body = content.slice(match[0].length);

  // Simple YAML parsing (id and severity only)
  const frontmatter: Partial<RuleFrontmatter> = {};

  for (const line of yamlContent.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key === 'id') {
      frontmatter.id = value;
    } else if (key === 'severity') {
      const validSeverities = ['blocker', 'high', 'medium', 'low', 'info'];
      if (validSeverities.includes(value)) {
        frontmatter.severity = value as RuleFrontmatter['severity'];
      }
    } else if (key === 'type' && (value === 'positive' || value === 'negative')) {
      frontmatter.type = value;
    }
  }

  if (!frontmatter.id) {
    return { frontmatter: null, body: content };
  }

  return { frontmatter: frontmatter as RuleFrontmatter, body };
}
