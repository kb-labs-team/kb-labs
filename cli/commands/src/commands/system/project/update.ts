/** project update — change a registered project's path or metadata without changing its identity. */

import { defineSystemCommand, type CommandResult } from '@kb-labs/shared-command-kit';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import type { ProjectRecord } from '@kb-labs/core-contracts';
import { ProjectRegistryError, projectErrorEnvelope } from '@kb-labs/core-project-registry';
import { generateExamples } from '../../../utils/generate-examples';
import { failWithEnvelope, openRegistry, projectRef } from './project-support';

type UpdateFlags = {
  json: { type: 'boolean'; description?: string };
  path: { type: 'string'; description?: string };
  title: { type: 'string'; description?: string };
  description: { type: 'string'; description?: string };
};

export type ProjectUpdateResult = CommandResult & { project?: ProjectRecord };

export const projectUpdate = defineSystemCommand<UpdateFlags, ProjectUpdateResult>({
  name: 'update',
  description: 'Update a project path or its metadata',
  longDescription: 'Updates a registered project while preserving its project ID and runtime state directory. Relative paths are resolved against the command cwd.',
  category: 'project',
  examples: generateExamples('project update', 'kb', [
    { flags: { path: '/work/new-location' }, description: 'repair a moved project path from the current project' },
    { flags: { title: 'Current title', description: 'Project description' } },
    { flags: { path: '../moved-workspace', json: true } },
  ]),
  flags: {
    json: { type: 'boolean', description: 'Output machine-readable JSON' },
    path: { type: 'string', description: 'New existing project folder path' },
    title: { type: 'string', description: 'New user-facing title' },
    description: { type: 'string', description: 'New project description' },
  },
  analytics: {
    command: 'project.update',
    startEvent: 'PROJECT_UPDATE_STARTED',
    finishEvent: 'PROJECT_UPDATE_FINISHED',
  },
  async handler(ctx, argv, flags) {
    const json = Boolean(flags.json);
    const ui: PluginContextV3['ui'] | undefined = ctx.ui;
    try {
      if (flags.path === undefined && flags.title === undefined && flags.description === undefined) {
        throw new ProjectRegistryError('KB_RUNTIME_INPUT_INVALID', 'Provide at least one of --path, --title, or --description.');
      }
      const cwd = getContextCwd(ctx);
      const path = flags.path === undefined ? undefined : projectRef(flags.path, cwd);
      const project = await openRegistry().update(projectRef(argv[0], cwd), {
        ...(path !== undefined ? { path } : {}),
        ...(flags.title !== undefined ? { title: flags.title } : {}),
        ...(flags.description !== undefined ? { description: flags.description } : {}),
      });
      if (json) ui?.json({ ok: true, project });
      else {
        ui?.success(`Updated ${project.title} (${project.id})`);
        ui?.write(`  path: ${project.path}\n`);
      }
      return { ok: true, project };
    } catch (error) {
      return failWithEnvelope(ui, projectErrorEnvelope(error), json);
    }
  },
});
