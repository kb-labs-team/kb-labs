/**
 * Plugin Setup - Declarative configuration
 *
 * Uses defineSetup for high-level declarative setup.
 * All operations are analyzed/diffed by kb setup-engine.
 */

import { defineSetup } from '@kb-labs/sdk/lifecycle';
import { defaultPluginConfig, type PluginConfig } from '@kb-labs/plugin-template-contracts';

const TEMPLATE_DIR = '.kb/template';
const CONFIG_PATH = `${TEMPLATE_DIR}/hello-config.json`;

/**
 * Plugin setup using declarative defineSetup API
 *
 * Uses PluginConfig from contracts as single source of truth.
 */
export const setup = defineSetup<PluginConfig>({
  files: [
    {
      path: CONFIG_PATH,
      content: () =>
        JSON.stringify(
          {
            greeting: 'Welcome to your KB Labs plugin workspace!',
            hint: 'Edit this file to customise messages produced by template surfaces.',
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        ) + '\n',
      description: 'Seed hello-config.json with defaults',
    },
    {
      path: `${TEMPLATE_DIR}/README.md`,
      content: [
        '# Template plugin workspace files',
        '',
        '- `hello-config.json` — example configuration read by CLI/REST/Studio surfaces.',
        '- Extend this folder with rules, profiles, or other assets required by your plugin.',
        '',
        'Re-run `kb plugin-template setup --force` whenever you want to regenerate defaults.',
      ].join('\n') + '\n',
      description: 'README hints for template directory',
    },
  ],

  config: [
    {
      pointer: 'plugins.template',
      value: defaultPluginConfig, // TypeScript validates against PluginConfig!
    },
  ],

  scripts: [
    {
      name: 'template:hello',
      command: 'kb plugin-template hello',
      description: 'Say hello from the template plugin',
    },
  ],

  gitignore: ['.kb/template/output/', '.kb/template/cache/'],

  notes: [
    'Adjust hello-config.json to plug into your own CLI/REST logic.',
    'Use --kb-only if you customise permissions to touch project files.',
  ],
});

/**
 * Setup handler function (for manifest registration)
 */
export async function run() {
  return {
    message: 'Template setup completed. Try `kb plugin-template hello` to see it in action!',
    ...setup,
  };
}

export default run;
