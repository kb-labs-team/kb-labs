/**
 * @module @kb-labs/review/llm/llm-lite/category-validator
 * Dynamic category discovery from rules directory.
 *
 * Categories are NOT hardcoded - they come from .kb/review/rules/ subdirectories.
 */

import type { ReviewConfig } from '../../contracts/index.js';
import { useConfig } from '@kb-labs/sdk';
import { readdir, access } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Common aliases for category names
 * Maps common LLM outputs to standard category names (if they exist)
 */
const COMMON_CATEGORY_MAPPINGS: Record<string, string[]> = {
  security: ['sec', 'vulnerability', 'vulnerabilities', 'injection', 'auth', 'authentication', 'authorization'],
  performance: ['perf', 'speed', 'memory', 'optimization', 'optimisation'],
  architecture: ['design', 'structure', 'pattern', 'patterns', 'arch'],
  naming: ['names', 'conventions', 'identifiers', 'naming-convention'],
  consistency: ['style', 'formatting', 'code-style', 'codestyle'],
  testing: ['test', 'tests', 'coverage', 'unit-test', 'unittest'],
  correctness: ['bug', 'bugs', 'logic', 'error', 'errors', 'mistake'],
  maintainability: ['readability', 'complexity', 'code-quality', 'quality'],
};

/**
 * CategoryValidator - discovers and validates categories dynamically
 *
 * Categories come from .kb/review/rules/ subdirectories.
 * No hardcoded categories - fully configurable per project.
 */
export class CategoryValidator {
  private validCategories: string[] = [];
  private categoryAliases: Record<string, string> = {};
  private defaultCategory: string = 'other';
  private initialized: boolean = false;

  /**
   * Initialize validator - discovers categories from config-defined rules directory
   *
   * @param cwd - Project root directory (ctx.cwd from command handler)
   */
  async init(cwd: string): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.validCategories = await discoverCategories(cwd);

    if (this.validCategories.length === 0) {
      // No categories found, will accept any category
      this.initialized = true;
      return;
    }

    this.categoryAliases = buildCategoryAliases(this.validCategories);
    this.defaultCategory = this.validCategories[0] ?? 'general';
    this.initialized = true;
  }

  /**
   * Validate and normalize a category value
   */
  validate(category: string): { valid: boolean; normalized: string } {
    if (this.validCategories.length === 0) {
      // No validation possible - accept but mark as unvalidated
      return { valid: false, normalized: category };
    }

    const lower = category.toLowerCase().trim();

    // Direct match
    if (this.validCategories.includes(lower)) {
      return { valid: true, normalized: lower };
    }

    // Alias match
    if (this.categoryAliases[lower]) {
      return { valid: true, normalized: this.categoryAliases[lower] };
    }

    // Invalid - use default
    return { valid: false, normalized: this.defaultCategory };
  }

  /**
   * Get list of valid categories
   */
  getValidCategories(): string[] {
    return [...this.validCategories];
  }

  /**
   * Get category aliases map
   */
  getCategoryAliases(): Record<string, string> {
    return { ...this.categoryAliases };
  }

  /**
   * Check if validator has been initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * Discover valid categories from rules directory
 *
 * Reads subdirectories of .kb/review/rules/ (or config-defined path).
 * Each subdirectory name becomes a valid category.
 *
 * @example
 * .kb/review/rules/
 *   ├── security/        → "security"
 *   ├── naming/          → "naming"
 *   ├── architecture/    → "architecture"
 *   └── .hidden/         → (ignored)
 */
export async function discoverCategories(cwd: string): Promise<string[]> {
  try {
    // Use SDK's useConfig to get review config from kb.config.json
    const config = await useConfig<ReviewConfig>();

    // Get rulesDir from config (with fallback)
    const rulesDir = config?.rulesDir ?? 'review/rules';
    const kbDir = path.join(cwd, '.kb');
    const fullPath = path.join(kbDir, rulesDir);

    // Check if rules directory exists
    try {
      await access(fullPath);
    } catch {
      // Rules directory not found
      return [];
    }

    // Read subdirectories
    const entries = await readdir(fullPath, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name.toLowerCase());
  } catch {
    // Error discovering categories
    return [];
  }
}

/**
 * Build category aliases from discovered categories
 *
 * Maps common LLM outputs to actual category names (if they exist in the project).
 */
export function buildCategoryAliases(validCategories: string[]): Record<string, string> {
  const aliases: Record<string, string> = {};
  const categorySet = new Set(validCategories);

  for (const category of validCategories) {
    // Add the category itself (for case normalization)
    aliases[category] = category;

    // Add common aliases if this category exists
    const mappings = COMMON_CATEGORY_MAPPINGS[category];
    if (mappings) {
      for (const alias of mappings) {
        // Only add alias if it doesn't conflict with another category
        if (!categorySet.has(alias)) {
          aliases[alias] = category;
        }
      }
    }
  }

  return aliases;
}

/**
 * Create a CategoryValidator instance
 */
export function createCategoryValidator(): CategoryValidator {
  return new CategoryValidator();
}

// Singleton instance for convenience
let globalValidator: CategoryValidator | null = null;

/**
 * Get or create the global CategoryValidator instance
 */
export async function getCategoryValidator(cwd: string): Promise<CategoryValidator> {
  if (!globalValidator) {
    globalValidator = new CategoryValidator();
  }

  if (!globalValidator.isInitialized()) {
    await globalValidator.init(cwd);
  }

  return globalValidator;
}

/**
 * Reset the global validator (for testing)
 */
export function resetCategoryValidator(): void {
  globalValidator = null;
}
