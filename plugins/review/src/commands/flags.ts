/**
 * Command flags definitions for AI Review plugin
 */

import { defineFlags } from '@kb-labs/sdk';

/**
 * Flags for review:run command
 */
export const runFlags = defineFlags({
  mode: {
    type: 'string',
    description: 'Review mode: heuristic (CI), full (local), llm (deep)',
    choices: ['heuristic', 'full', 'llm'],
    default: 'heuristic',
  },
  scope: {
    type: 'string',
    description: 'File scope: all, changed (vs main), staged',
    choices: ['all', 'changed', 'staged'],
    default: 'changed',
  },
  repos: {
    type: 'array',
    description: 'Repository scope (submodule names to include, e.g., --repos kb-labs-core kb-labs-cli)',
  },
  task: {
    type: 'string',
    description: 'Task context - describe what the changes are trying to achieve',
  },
  preset: {
    type: 'string',
    description: 'Preset ID (e.g., typescript-strict)',
  },
  files: {
    type: 'array',
    description: 'File patterns to analyze',
  },
  'eslint-config': {
    type: 'string',
    description: 'ESLint config file path',
  },
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
});
