import { defineCommandFlags, combinePermissions, generateExamples } from '@kb-labs/sdk';
import {
  switchFlags,
  statusFlags,
  planFlags,
  freezeFlags,
  undoFlags,
  backupsFlags,
  DEVLINK_CACHE_PREFIX,
} from './contracts/index.js';

const pluginPermissions = combinePermissions()
  .withFs({
    mode: 'readWrite',
    allow: ['**/package.json', '.kb/devlink/**', '**/pnpm-workspace.yaml'],
  })
  .withPlatform({
    cache: [DEVLINK_CACHE_PREFIX],
  })
  .withQuotas({
    timeoutMs: 1800000, // 30 min — mode set --install runs pnpm install in 29 sub-repos
    memoryMb: 512,
  })
  .build();

export const manifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/devlink',
  version: '1.0.0',

  display: {
    name: 'DevLink',
    description: 'Cross-repo link: dependency management',
    tags: ['monorepo', 'devlink', 'dependencies', 'publish', 'local-dev'],
  },

  platform: {
    requires: ['storage'],
    optional: [],
  },

  cli: {
    groupMeta: [
      { path: 'devlink', describe: 'Cross-repo link: dependency management' },
    ],
    commands: [
      {
        path: 'devlink mode set',
        category: 'Mode',
        describe: 'Switch deps between local link: and npm (CI/CD) mode',
        operationType: 'mutate' as const,
        longDescription:
          'Replaces all cross-repo @kb-labs/* dependencies across monorepos. ' +
          'Creates a backup before applying. Run pnpm install after switching.',

        handler: './cli/commands/switch.js#default',

        flags: defineCommandFlags(switchFlags),

        examples: generateExamples('devlink mode set', 'kb', [
          { description: 'Switch to npm mode (CI/CD)', flags: { mode: 'npm' } },
          { description: 'Switch to local mode (development)', flags: { mode: 'local' } },
          { description: 'Preview changes without applying', flags: { mode: 'local', 'dry-run': true } },
          { description: 'Switch specific repos only', flags: { mode: 'npm', repos: 'kb-labs-cli,kb-labs-core' } },
        ]),

        permissions: pluginPermissions,
      },
      {
        path: 'devlink status',
        category: 'Mode',
        describe: 'Show current state of cross-repo dependencies',
        operationType: 'read' as const,
        longDescription:
          'Displays the current linking mode, counts of link: vs npm dependencies, ' +
          'and any discrepancies across all monorepos.',

        handler: './cli/commands/status.js#default',

        flags: defineCommandFlags(statusFlags),

        examples: generateExamples('devlink status', 'kb', [
          { description: 'Show summary status', flags: {} },
          { description: 'Verbose output with all deps', flags: { verbose: true } },
          { description: 'JSON output for scripting', flags: { json: true } },
        ]),

        permissions: pluginPermissions,
      },
      {
        path: 'devlink plan',
        category: 'Mode',
        describe: 'Preview what would change when switching mode',
        operationType: 'read' as const,
        longDescription:
          'Shows all dependency changes that would be made without applying them. ' +
          'Useful for reviewing before running mode set.',

        handler: './cli/commands/plan.js#default',

        flags: defineCommandFlags(planFlags),

        examples: generateExamples('devlink plan', 'kb', [
          { description: 'Plan switch to local mode', flags: { mode: 'local' } },
          { description: 'Plan switch to npm mode', flags: { mode: 'npm' } },
          { description: 'JSON output for scripting', flags: { mode: 'npm', json: true } },
        ]),

        permissions: pluginPermissions,
      },
      {
        path: 'devlink lock create',
        category: 'State',
        describe: 'Freeze current dependency state to lock file',
        operationType: 'mutate' as const,
        longDescription:
          'Saves a snapshot of current dependency mode to .kb/devlink/lock.json. ' +
          'Use to record a stable known-good state.',

        handler: './cli/commands/freeze.js#default',

        flags: defineCommandFlags(freezeFlags),

        examples: generateExamples('devlink lock create', 'kb', [
          { description: 'Freeze current state', flags: {} },
          { description: 'JSON output', flags: { json: true } },
        ]),

        permissions: pluginPermissions,
      },
      {
        path: 'devlink rollback',
        category: 'State',
        describe: 'Restore previous dependency state from last backup',
        operationType: 'mutate' as const,
        longDescription:
          'Restores package.json files from the most recent backup created by mode set. ' +
          'Run pnpm install after undoing.',

        handler: './cli/commands/undo.js#default',

        flags: defineCommandFlags(undoFlags),

        examples: generateExamples('devlink rollback', 'kb', [
          { description: 'Undo last switch', flags: {} },
          { description: 'JSON output', flags: { json: true } },
        ]),

        permissions: pluginPermissions,
      },
      {
        path: 'devlink backup list',
        category: 'State',
        describe: 'List and restore backups',
        operationType: 'read' as const,
        longDescription:
          'Lists all available backups. Use --restore <id> to restore a specific backup.',

        handler: './cli/commands/backups.js#default',

        flags: defineCommandFlags(backupsFlags),

        examples: generateExamples('devlink backup list', 'kb', [
          { description: 'List all backups', flags: {} },
          { description: 'JSON output', flags: { json: true } },
          { description: 'Restore specific backup', flags: { restore: '<backup-id>' } },
        ]),

        permissions: pluginPermissions,
      },
    ],
  },

  permissions: pluginPermissions,
};
