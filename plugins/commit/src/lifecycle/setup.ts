/**
 * Setup handler for commit plugin
 * Initializes .kb/commit/ directory structure and config
 */

import { defaultCommitConfig } from '../contracts/index.js';

const COMMIT_DIR = '.kb/commit';

/**
 * Plugin setup configuration
 *
 * Uses CommitPluginConfig from contracts as single source of truth.
 */
export const setup = {
  files: [
    {
      path: `${COMMIT_DIR}/README.md`,
      content: [
        '# Commit Plugin Workspace',
        '',
        'This directory contains commit plugin data:',
        '',
        '- `current/` - Current commit plan (generated, not committed)',
        '- `history/` - Applied commit plans history',
        '',
        '## Configuration',
        '',
        'Plugin configuration is stored in `kb.config.json` under `plugins.commit`.',
        '',
        '### Environment Variables',
        '',
        '| Variable | Description | Default |',
        '|----------|-------------|---------|',
        '| `KB_COMMIT_LLM_ENABLED` | Enable/disable LLM | `true` |',
        '| `KB_COMMIT_LLM_TEMPERATURE` | LLM temperature (0-1) | `0.3` |',
        '| `KB_COMMIT_LLM_MAX_TOKENS` | Max tokens for LLM | `2000` |',
        '| `KB_COMMIT_STORAGE_DIR` | Storage directory | `.kb/commit` |',
        '| `KB_COMMIT_AUTO_STAGE` | Auto-stage changes | `false` |',
        '',
        '## Commands',
        '',
        '```bash',
        '# Full flow: generate → apply',
        'kb commit',
        '',
        '# Generate plan only',
        'kb commit:generate',
        '',
        '# Apply current plan',
        'kb commit:apply',
        '',
        '# View current plan',
        'kb commit:open',
        '',
        '# Reset current plan',
        'kb commit:reset',
        '',
        '# Push commits',
        'kb commit:push',
        '```',
        '',
        'Re-run `kb commit setup --force` to regenerate defaults.',
      ].join('\n') + '\n',
      description: 'README for commit plugin workspace',
    },
  ],

  config: [
    {
      pointer: 'plugins.commit',
      value: defaultCommitConfig,
    },
  ],

  scripts: [
    {
      name: 'commit',
      command: 'kb commit',
      description: 'Generate and apply commits',
    },
    {
      name: 'commit:generate',
      command: 'kb commit:generate',
      description: 'Generate commit plan from changes',
    },
  ],

  gitignore: [
    '.kb/commit/current/',
    '.kb/commit/history/',
  ],

  notes: [
    'Run `kb commit` to analyze changes and generate commit plan.',
    'Generating a plan needs an LLM: bind one with `kb adapter bind llm <installed-adapter-package>`.',
    'Use `kb commit:open` to view current plan before applying.',
  ],
};

/**
 * Setup handler function (for manifest registration)
 */
export async function run() {
  return {
    message: 'Commit plugin setup completed. Try `kb commit` to generate commits!',
    ...setup,
  };
}

export default run;
