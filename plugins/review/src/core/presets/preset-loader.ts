/**
 * @module @kb-labs/review/core/presets/preset-loader
 * Preset loading and resolution logic
 */

import type { PresetDefinition, ReviewConfig } from '../../contracts/index.js';
import { builtinPresets } from './builtin-presets.js';
import { useConfig, useLogger } from '@kb-labs/sdk';

/**
 * Deep merge two objects
 */
 
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target } as T;

  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (sourceValue === undefined) {
      continue;
    }

    if (
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      // Deep merge objects
      result[key] = deepMerge(targetValue, sourceValue) as T[Extract<keyof T, string>];
    } else if (Array.isArray(sourceValue) && Array.isArray(targetValue)) {
      // Concatenate arrays (no duplicates)
      result[key] = [...new Set([...targetValue, ...sourceValue])] as T[Extract<keyof T, string>];
    } else {
      // Override primitives and non-matching types
      result[key] = sourceValue as T[Extract<keyof T, string>];
    }
  }

  return result;
}

/**
 * Preset loader
 * Resolves presets from builtin definitions and kb.config.json
 */
export class PresetLoader {
  private presets: Map<string, PresetDefinition>;
  private configLoaded: boolean = false;

  constructor() {
    this.presets = new Map();
    this.loadBuiltinPresets();
  }

  /**
   * Load builtin presets
   */
  private loadBuiltinPresets(): void {
    for (const preset of builtinPresets) {
      this.presets.set(preset.id, preset);
    }
  }

  /**
   * Resolve preset inheritance (extends) with cycle detection
   */
  private resolveInheritance(preset: PresetDefinition, visited: Set<string> = new Set()): PresetDefinition {
    if (!preset.extends) {
      return preset;
    }

    // Cycle detection: check if we've seen this preset before
    if (visited.has(preset.id)) {
      const chain = Array.from(visited).join(' -> ') + ' -> ' + preset.id;
      throw new Error(
        `Circular inheritance detected in presets: ${chain}`
      );
    }

    // Add current preset to visited set
    visited.add(preset.id);

    // Find parent preset
    const parent = this.presets.get(preset.extends);

    if (!parent) {
      throw new Error(
        `Preset '${preset.id}' extends '${preset.extends}', but parent preset not found`
      );
    }

    // Recursively resolve parent (in case parent also extends)
    const resolvedParent = this.resolveInheritance(parent, visited);

    // Merge parent into child (child overrides parent)
    const merged = deepMerge(resolvedParent, preset);

    // Remove extends field from final preset
    delete merged.extends;

    return merged;
  }

  /**
   * Load custom presets from kb.config.json and preset files
   * Called lazily on first preset access
   */
  private async loadConfigPresets(): Promise<void> {
    if (this.configLoaded) {
      return;
    }

    try {
      // 1. Load presets from kb.config.json
      const config = await useConfig<ReviewConfig>();

      if (config?.presets) {
        // Load presets from file paths or inline definitions
        for (const presetOrPath of config.presets) {
          if (typeof presetOrPath === 'string') {
            // It's a file path - load preset from file
             
            await this.loadPresetFromFile(presetOrPath);
          } else {
            // It's an inline preset definition
            this.presets.set(presetOrPath.id, presetOrPath);
          }
        }
      }

      // 2. Auto-scan .kb/review/presets/ directory
      await this.scanPresetsDirectory();

      this.configLoaded = true;
    } catch {
      // Silently fail if config not available
      this.configLoaded = true;
    }
  }

  /**
   * Auto-scan .kb/review/presets/ directory for preset files
   */
  private async scanPresetsDirectory(): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const pathModule = await import('path');

      const presetsDir = pathModule.join(process.cwd(), '.kb', 'review', 'presets');

      // Check if directory exists
      try {
        await fs.access(presetsDir);
      } catch {
        // Directory doesn't exist, skip
        return;
      }

      // Read all JSON files
      const entries = await fs.readdir(presetsDir, { withFileTypes: true });
      const jsonFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json'));

      for (const file of jsonFiles) {
        // Path traversal protection
        if (file.name.includes('..') || file.name.includes(pathModule.sep)) {
          continue;
        }

        const filePath = pathModule.join(presetsDir, file.name);

        try {
           
          const content = await fs.readFile(filePath, 'utf-8');
          const preset = JSON.parse(content) as PresetDefinition;

          if (preset.id) {
            this.presets.set(preset.id, preset);
          }
        } catch {
          // Skip invalid files
        }
      }
    } catch {
      // Directory scan failed, continue without custom presets
    }
  }

  /**
   * Load preset from JSON file
   */
  private async loadPresetFromFile(relativePath: string): Promise<void> {
    try {
      // Resolve path relative to .kb/ directory
      const fs = await import('fs/promises');
      const path = await import('path');

      const configDir = path.join(process.cwd(), '.kb');
      const presetPath = path.join(configDir, relativePath);

      const content = await fs.readFile(presetPath, 'utf-8');
      const preset = JSON.parse(content) as PresetDefinition;

      this.presets.set(preset.id, preset);
    } catch (error) {
      useLogger()?.debug(`[PresetLoader] Failed to load preset from ${relativePath}:`, { error });
    }
  }

  /**
   * Load atomic rule from .md file
   */
  private async loadAtomicRule(category: string, ruleName: string): Promise<string | undefined> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      const configDir = path.join(process.cwd(), '.kb');
      const rulePath = path.join(configDir, 'review', 'rules', category, `${ruleName}.md`);

      const content = await fs.readFile(rulePath, 'utf-8');
      return content.trim();
    } catch (error) {
      useLogger()?.debug(`[PresetLoader] Failed to load atomic rule ${category}/${ruleName}:`, { error });
      return undefined;
    }
  }

  /**
   * Compose atomic rules into convention text
   */
  private async composeRules(
    category: string,
    include?: string[],
    exclude?: string[]
  ): Promise<string> {
    if (!include || include.length === 0) {
      return '';
    }

    const rules: string[] = [];

    for (const ruleName of include) {
      // Skip if excluded
      if (exclude?.includes(ruleName)) {
        continue;
      }

       
      const ruleContent = await this.loadAtomicRule(category, ruleName);
      if (ruleContent) {
        rules.push(ruleContent);
      }
    }

    // Join with double newline separator
    return rules.join('\n\n');
  }

  /**
   * Apply atomic rules composition to preset
   * Supports dynamic categories - any category name defined in atomicRules
   */
  private async applyAtomicRules(preset: PresetDefinition): Promise<PresetDefinition> {
    if (!preset.atomicRules) {
      return preset;
    }

    // Ensure context.conventions exists
    if (!preset.context) {
      preset.context = {};
    }
    if (!preset.context.conventions) {
      preset.context.conventions = {};
    }

    // Iterate over all categories defined in atomicRules
    // This allows users to create custom categories without modifying code
    for (const category in preset.atomicRules) {
      const ruleConfig = preset.atomicRules[category];
      if (!ruleConfig) {
        continue;
      }

       
      const composedRules = await this.composeRules(
        category,
        ruleConfig.include,
        ruleConfig.exclude
      );

      if (composedRules) {
        // Append to existing conventions (or replace)
        const existingConventions = preset.context.conventions[category] || '';

        // If atomic rules exist, they take priority over inline conventions
        // But we can append inline conventions at the end
        if (existingConventions) {
          preset.context.conventions[category] = `${composedRules}\n\n${existingConventions}`;
        } else {
          preset.context.conventions[category] = composedRules;
        }
      }
    }

    return preset;
  }

  /**
   * Get preset by ID (with inheritance resolved)
   */
  async getPreset(id: string): Promise<PresetDefinition | undefined> {
    await this.loadConfigPresets();
    const preset = this.presets.get(id);

    if (!preset) {
      return undefined;
    }

    // Resolve inheritance
    const resolved = this.resolveInheritance(preset);

    // Apply atomic rules composition
    return this.applyAtomicRules(resolved);
  }

  /**
   * Get preset by ID or throw error
   */
  async getPresetOrThrow(id: string): Promise<PresetDefinition> {
    const preset = await this.getPreset(id);
    if (!preset) {
      const available = Array.from(this.presets.keys()).join(', ');
      throw new Error(
        `Preset not found: "${id}"\n` +
        `Available presets: ${available}`
      );
    }
    return preset;
  }

  /**
   * List all available presets
   */
  async listPresets(): Promise<PresetDefinition[]> {
    await this.loadConfigPresets();
    return Array.from(this.presets.values());
  }

  /**
   * Register custom preset
   */
  registerPreset(preset: PresetDefinition): void {
    this.presets.set(preset.id, preset);
  }
}

/**
 * Global preset loader instance
 */
let globalLoader: PresetLoader | undefined;

/**
 * Get global preset loader
 */
export function getPresetLoader(): PresetLoader {
  if (!globalLoader) {
    globalLoader = new PresetLoader();
  }
  return globalLoader;
}

/**
 * Load preset by ID
 */
export async function loadPreset(id: string): Promise<PresetDefinition> {
  return getPresetLoader().getPresetOrThrow(id);
}
