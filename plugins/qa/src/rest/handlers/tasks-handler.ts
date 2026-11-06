import { defineHandler, useConfig, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { type QAPluginConfig } from '../../contracts/index.js';

function readDevkitTasks(cwd: string): string[] {
  const configFile = join(cwd, 'devkit.yaml');
  if (!existsSync(configFile)) return [];

  try {
    const raw = load(readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
    const tasks = raw?.tasks;
    if (tasks && typeof tasks === 'object' && !Array.isArray(tasks)) {
      return Object.keys(tasks);
    }
  } catch {
    // malformed yaml — fall through
  }
  return [];
}

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput) {
    try {
      const config = await useConfig<QAPluginConfig>();
      const devkitTasks = readDevkitTasks(ctx.cwd);
      const defaultTasks = config?.defaultTasks ?? null;

      return {
        tasks: devkitTasks,
        defaultTasks,
      };
    } catch (error) {
      rethrowForRest(error);
    }
  },
});
