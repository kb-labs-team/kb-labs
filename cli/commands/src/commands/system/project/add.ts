/**
 * project add — register a folder in the machine-level project registry.
 *
 * A folder that already has `.kb/` is picked up as-is. A folder without
 * `.kb/` is NOT initialized silently: the command returns a typed
 * `initializationRequired` result, unless `--init` is passed, in which case
 * the minimal `.kb/` is created through the same routine `kb init` uses
 * (`initWorkspaceConfig` from @kb-labs/core-config).
 */

import { defineSystemCommand, type CommandResult } from '@kb-labs/shared-command-kit';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import { addProject, projectErrorEnvelope, type AddProjectOutcome } from '@kb-labs/core-project-registry';
import type { ProjectRecord } from '@kb-labs/core-contracts';
import { generateExamples } from '../../../utils/generate-examples';
import { failWithEnvelope, openRegistry } from './project-support';

type Ui = PluginContextV3['ui'];

function reportInitializationRequired(ui: Ui | undefined, path: string, json: boolean) {
  const nextStep = `kb project add ${path} --init`;
  const payload = { ok: false as const, initializationRequired: true, path, nextStep };
  if (json) {
    ui?.json(payload);
  } else {
    ui?.warn(`${path} has no .kb/ directory, so it was not registered.`);
    ui?.write(`Initialize and register it in one step: ${nextStep}\n`);
  }
  return { ...payload, error: 'Project initialization required' };
}

function reportPlanned(
  ui: Ui | undefined,
  outcome: Extract<AddProjectOutcome, { status: 'planned' }>,
  json: boolean,
) {
  const payload = {
    ok: true as const,
    dryRun: true,
    project: outcome.project,
    wouldInitialize: outcome.wouldInitialize,
  };
  if (json) {
    ui?.json(payload);
  } else {
    ui?.info(`Dry run: would register ${outcome.project.name} (${outcome.project.id}) at ${outcome.project.path}`);
    if (outcome.wouldInitialize) {
      ui?.write('Dry run: would create .kb/ with a minimal configuration.\n');
    }
  }
  return payload;
}

function reportAdded(ui: Ui | undefined, outcome: Extract<AddProjectOutcome, { status: 'added' }>, json: boolean) {
  const { project, initialized, created } = outcome;
  const payload = { ok: true as const, project, initialized, created };
  if (json) {
    ui?.json(payload);
  } else {
    ui?.success(`Registered ${project.name} (${project.id})`);
    ui?.write(`  path: ${project.path}\n`);
    if (initialized) {
      ui?.write(`  created: ${created.join(', ') || '.kb/'}\n`);
    }
  }
  return payload;
}

type AddFlags = {
  json: { type: 'boolean'; description?: string };
  'dry-run': { type: 'boolean'; description?: string };
  init: { type: 'boolean'; description?: string };
  name: { type: 'string'; description?: string };
};

export type ProjectAddResult = CommandResult & {
  /** True when the folder has no `.kb/` and `--init` was not passed; nothing was registered. */
  initializationRequired?: boolean;
  dryRun?: boolean;
  project?: ProjectRecord;
  path?: string;
  initialized?: boolean;
  wouldInitialize?: boolean;
  created?: string[];
  nextStep?: string;
};

export const projectAdd = defineSystemCommand<AddFlags, ProjectAddResult>({
  name: 'add',
  description: 'Register a project folder with the platform',
  longDescription:
    'Adds a folder to the machine-level project registry (KB_HOME/projects.json, default ~/.kb). ' +
    'A folder that already has .kb/ is picked up as-is. A folder without .kb/ is not modified: ' +
    'the command reports that initialization is needed; pass --init to create the minimal .kb/ as well.',
  category: 'project',
  examples: generateExamples('project add', 'kb', [
    { flags: {}, description: 'register the current folder' },
    { flags: { init: true }, description: 'register and create .kb/ if missing' },
    { flags: { 'dry-run': true, json: true } },
  ]),
  flags: {
    json: { type: 'boolean', description: 'Output machine-readable JSON' },
    'dry-run': { type: 'boolean', description: 'Show what would happen without changing anything' },
    init: { type: 'boolean', description: 'Create the minimal .kb/ when the folder has none' },
    name: { type: 'string', description: 'Alias for the project (default: folder name)' },
  },
  analytics: {
    command: 'project.add',
    startEvent: 'PROJECT_ADD_STARTED',
    finishEvent: 'PROJECT_ADD_FINISHED',
  },
  async handler(ctx, argv, flags) {
    const json = Boolean(flags.json);
    const dryRun = Boolean(flags['dry-run']);
    const init = Boolean(flags.init);
    const ui = ctx.ui;

    try {
      const outcome = await addProject(openRegistry(), {
        path: argv[0] ?? '.',
        cwd: getContextCwd(ctx),
        name: flags.name,
        init,
        dryRun,
      });

      if (outcome.status === 'initialization-required') {
        return reportInitializationRequired(ui, outcome.path, json);
      }
      if (outcome.status === 'planned') {
        return reportPlanned(ui, outcome, json);
      }
      return reportAdded(ui, outcome, json);
    } catch (error) {
      return failWithEnvelope(ui, projectErrorEnvelope(error), json);
    }
  },
});
