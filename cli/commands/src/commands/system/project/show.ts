/** project show — details of one registered project (id, name or path; defaults to the current folder). */

import { defineSystemCommand, type CommandResult } from '@kb-labs/shared-command-kit';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import { generateExamples } from '../../../utils/generate-examples';
import { failWithEnvelope, openRegistry, projectRef, toProjectEnvelope, toRow, type ProjectRow } from './project-support';

type ShowFlags = {
  json: { type: 'boolean'; description?: string };
};

export type ProjectShowResult = CommandResult & {
  project?: ProjectRow;
};

export const projectShow = defineSystemCommand<ShowFlags, ProjectShowResult>({
  name: 'show',
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
      const view = await openRegistry().get(projectRef(argv[0], getContextCwd(ctx)));
      const project = toRow(view);
      if (json) {
        ctx.ui?.json({ ok: true, project });
      } else {
        ctx.ui?.write(`${project.name} (${project.id})\n`);
        ctx.ui?.write(`  path:        ${project.path}${project.pathExists ? '' : '  (folder missing)'}\n`);
        ctx.ui?.write(`  status:      ${project.status}\n`);
        ctx.ui?.write(`  .kb/:        ${project.declaration}\n`);
        ctx.ui?.write(`  added:       ${project.addedAt}\n`);
        ctx.ui?.write(`  last used:   ${project.lastUsedAt ?? 'never'}\n`);
        ctx.ui?.write(`  state dir:   ${project.stateDir}\n`);
      }
      return { ok: true, project };
    } catch (error) {
      return failWithEnvelope(ctx.ui, toProjectEnvelope(error), json);
    }
  },
});
