/**
 * Template loader with validation
 *
 * Loads built-in or custom user templates from filesystem
 */

import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, isAbsolute, dirname } from 'node:path';
import { access } from 'node:fs/promises';
import type { ChangelogTemplate } from './types';

// Get current file directory in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Built-in template names
 */
export const BUILTIN_TEMPLATES = ['corporate', 'corporate-ai', 'technical', 'compact'] as const;
export type BuiltinTemplate = typeof BUILTIN_TEMPLATES[number];

/**
 * Load a changelog template
 *
 * @param templateName Template name (builtin) or path (custom)
 * @param cwd Current working directory (for resolving relative paths)
 * @returns Loaded and validated template
 */
export async function loadTemplate(
  templateName: string,
  cwd: string
): Promise<ChangelogTemplate> {
  // Check if builtin template
  if (isBuiltinTemplate(templateName)) {
    return loadBuiltinTemplate(templateName);
  }

  // Load custom template from filesystem
  return loadCustomTemplate(templateName, cwd);
}

/**
 * Check if template name is a built-in template
 */
function isBuiltinTemplate(name: string): name is BuiltinTemplate {
  return (BUILTIN_TEMPLATES as readonly string[]).includes(name);
}

/**
 * Load built-in template
 */
async function loadBuiltinTemplate(name: BuiltinTemplate): Promise<ChangelogTemplate> {
  try {
    // Use absolute path from current module directory
    // loader.ts is in src/templates/, compiled to dist/index.js
    // templates are in dist/templates/builtin/
    const templatePath = join(__dirname, 'templates', 'builtin', `${name}.js`);
    const templateUrl = pathToFileURL(templatePath).href;
    const module = await import(templateUrl);
    return validateTemplate(module, name);
  } catch (error) {
    throw new Error(
      `Failed to load built-in template "${name}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Load custom template from filesystem
 */
async function loadCustomTemplate(templatePath: string, cwd: string): Promise<ChangelogTemplate> {
  // Resolve path (relative or absolute)
  const fullPath = isAbsolute(templatePath) ? templatePath : join(cwd, templatePath);

  // Check if file exists
  try {
    await access(fullPath);
  } catch {
    throw new Error(`Template file not found: ${fullPath}`);
  }

  // Load module (supports .ts, .js, .mjs)
  try {
    // Convert to file:// URL for dynamic import
    const fileUrl = pathToFileURL(fullPath).href;
    const module = await import(fileUrl);

    return validateTemplate(module, templatePath);
  } catch (error) {
    throw new Error(
      `Failed to load custom template "${templatePath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Validate template module
 */
function validateTemplate(module: unknown, templateName: string): ChangelogTemplate {
  const m = module as Record<string, unknown>;
  // Check version field
  if (!m.version || m.version !== '1.0') {
    throw new Error(
      `Template "${templateName}" has invalid version (expected "1.0", got "${m.version ?? 'undefined'}")`
    );
  }

  // Check render function
  if (typeof m.render !== 'function') {
    throw new Error(`Template "${templateName}" must export a render() function`);
  }

  return m as unknown as ChangelogTemplate;
}

/**
 * List available built-in templates with descriptions
 */
export function listBuiltinTemplates(): Array<{ name: string; description: string }> {
  return [
    {
      name: 'corporate',
      description: 'Professional changelog with emoji and grouped sections (sync, fast)',
    },
    {
      name: 'corporate-ai',
      description: 'Corporate format with AI-enhanced descriptions (async, smart)',
    },
    {
      name: 'technical',
      description: 'Developer-focused with commit SHAs, authors, and all commit types',
    },
    {
      name: 'compact',
      description: 'Minimal one-line format for quick release notes',
    },
  ];
}
