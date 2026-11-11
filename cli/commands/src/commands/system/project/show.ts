/** project show — details of one registered project (id, name or path; defaults to the current folder). */

import { defineSystemCommand, type CommandResult } from '@kb-labs/shared-command-kit';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import { generateExamples } from '../../../utils/generate-examples';
import type { ProjectSummary } from '@kb-labs/core-contracts';
import { requireProjectContext } from '@kb-labs/core-runtime';
import {
  findProjectContainingPath,
  projectErrorEnvelope,
  showProject,
} from '@kb-labs/core-project-registry';
import { failWithEnvelope, openRegistry, projectRef } from './project-support';

type ShowFlags = {
  json: { type: 'boolean'; description?: string };
};

export type ProjectShowResult = CommandResult & {
  project?: ProjectSummary;
};

export const projectShow = defineSystemCommand<ShowFlags, ProjectShowResult>({
  name: 'show',
  scope: (argv) => argv.length === 0 ? 'project' : 'platform',
  jsonTest: { safeArgs: ["__fixture_project_id__"] },
  description: 'Show one registered project',
  longDescription:
    'Shows a project by id, name or path. Without an argument the current folder is looked up. ' +
    'A folder that was moved is a different, unknown project and must be added again.',
  category: 'project',
  examples: generateExamples('project show', 'kb', [{ flags: {} }, { flags: { json: true } }]),
  flags: {
    json: { type: 'boolean', description: 'Output machine-readable JSON' },
  },
  analytics: {
    command: 'project.show',
    startEvent: 'PROJECT_SHOW_STARTED',
    finishEvent: 'PROJECT_SHOW_FINISHED',
  },
  async handler(ctx, argv, flags) {
    const json = Boolean(flags.json);
    try {
      const registry = openRegistry();
      const cwd = getContextCwd(ctx);
      let ref = argv[0] === undefined ? undefined : projectRef(argv[0], cwd);
      if (ref === undefined) {
        const match = await findProjectContainingPath(registry, cwd);
        if (!match) {
          requireProjectContext(undefined, cwd);
        }
        ref = match.project.id;
      }
      const project = await showProject(registry, ref);
      if (!json) {
        ctx.ui?.write(`${project.name} (${project.id})\n`);
        ctx.ui?.write(`  path:        ${project.path}${project.pathExists ? '' : '  (folder missing)'}\n`);
        ctx.ui?.write(`  status:      ${project.status}\n`);
        ctx.ui?.write(`  .kb/:        ${project.declaration}\n`);
        ctx.ui?.write(`  added:       ${project.addedAt}\n`);
        ctx.ui?.write(`  last used:   ${project.lastUsedAt ?? 'never'}\n`);
        ctx.ui?.write(`  state dir:   ${project.stateDir}\n`);
      }
      return {  project };
    } catch (error) {
      return failWithEnvelope(projectErrorEnvelope(error));
    }
  },
});
