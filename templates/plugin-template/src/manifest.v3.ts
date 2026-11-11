/**
 * V3 Manifest for plugin-template
 *
 * Demonstrates V3 plugin architecture with migrated hello command.
 */

import { defineCommandFlags, combinePermissions, generateExamples } from '@kb-labs/sdk';

/**
 * Build permissions using V3 combinePermissions builder pattern.
 * Simple read-only permissions for demo plugin.
 */
const pluginPermissions = combinePermissions()
  .withFs({
    mode: 'read',
    allow: ['.kb/template/**'],
  })
  .withQuotas({
    timeoutMs: 10000,
    memoryMb: 128,
  })
  .build();

const helloPermissions = combinePermissions()
  .withFs({
    mode: 'read',
    allow: ['.kb/template/**'],
  })
  .withQuotas({
    timeoutMs: 5000,
    memoryMb: 64,
  })
  .build();

const loaderPermissions = combinePermissions()
  .withFs({
    mode: 'read',
    allow: ['.kb/template/**'],
  })
  .withQuotas({
    timeoutMs: 30000,
    memoryMb: 64,
  })
  .build();

export const manifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/plugin-template',
  version: '0.1.0',

  display: {
    name: 'Plugin Template (V3)',
    description: 'V3 reference plugin demonstrating new plugin architecture.',
    tags: ['template', 'hello', 'v3', 'sample'],
  },

  cli: {
    commands: [
      {
        id: 'plugin-template:hello',
        path: 'plugin-template hello',
        group: 'plugin-template',
        describe: 'Print a hello message (V3 migrated)',
        longDescription: 'V3 version with improved UI, timing tracking, and structured output.',

        handler: './cli/commands/hello.js#default',
        handlerPath: './cli/commands/hello.js',

        flags: defineCommandFlags({
          name: {
            type: 'string',
            description: 'Name to greet',
            default: 'World',
            alias: 'n',
          },
          json: {
            type: 'boolean',
            description: 'Output as JSON',
            default: false,
          },
        }),

        examples: generateExamples('hello', 'plugin-template', [
          { description: 'Basic greeting', flags: {} },
          { description: 'Greet specific name', flags: { name: 'Developer' } },
          { description: 'Output as JSON', flags: { json: true } },
        ]),

        permissions: helloPermissions,
      },
      {
        id: 'plugin-template:test-loader',
        path: 'plugin-template test-loader',
        group: 'plugin-template',
        describe: 'Test UI loader/spinner functionality (V3 migrated)',
        longDescription: 'Demonstrates spinner, multi-stage progress, and rapid updates for testing UI loader components.',

        handler: './cli/commands/test-loader.js#default',
        handlerPath: './cli/commands/test-loader.js',

        flags: defineCommandFlags({
          duration: {
            type: 'number',
            description: 'Duration of each stage in milliseconds',
            default: 2000,
            alias: 'd',
          },
          fail: {
            type: 'boolean',
            description: 'Simulate failure scenario',
            default: false,
            alias: 'f',
          },
          stages: {
            type: 'number',
            description: 'Number of progress stages to simulate',
            default: 3,
            alias: 's',
          },
        }),

        examples: generateExamples('test-loader', 'plugin-template', [
          { description: 'Basic loader test (3 stages, 2s each)', flags: {} },
          { description: 'Fast test (1s per stage)', flags: { duration: 1000 } },
          { description: 'Simulate failure', flags: { fail: true } },
          { description: 'Many stages', flags: { stages: 5, duration: 1000 } },
        ]),

        permissions: loaderPermissions,
      },
    ],
  },

  permissions: pluginPermissions,
};
