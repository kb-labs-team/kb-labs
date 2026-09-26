/** project list — show every registered project. */

import { defineSystemCommand, type CommandResult } from '@kb-labs/shared-command-kit';
import { generateExamples } from '../../../utils/generate-examples';
import { failWithEnvelope, openRegistry, toProjectEnvelope, toRow, type ProjectRow } from './project-support';

type ListFlags = {
  json: { type: 'boolean'; description?: string };
};

export type ProjectListResult = CommandResult & {
  projects?: ProjectRow[];
  total?: number;
};

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export const projectList = defineSystemCommand<ListFlags, ProjectListResult>({
  name: 'list',
  description: 'List registered projects',
  longDescription: 'Lists the projects in the machine-level registry with their status and last use.',
  category: 'project',
  examples: generateExamples('project list', 'kb', [{ flags: {} }, { flags: { json: true } }]),
  flags: {
    json: { type: 'boolean', description: 'Output machine-readable JSON' },
  },
  analytics: {
    command: 'project.list',
    startEvent: 'PROJECT_LIST_STARTED',
    finishEvent: 'PROJECT_LIST_FINISHED',
  },
  async handler(ctx, _argv, flags) {
    const json = Boolean(flags.json);
    try {
      const projects = (await openRegistry().list()).map(toRow);
      if (json) {
        ctx.ui?.json({ ok: true, projects, total: projects.length });
      } else if (projects.length === 0) {
        ctx.ui?.write('No projects registered. Add one with: kb project add <path>\n');
      } else {
        const nameWidth = Math.max(4, ...projects.map((p) => p.name.length));
        ctx.ui?.write(`${pad('NAME', nameWidth)}  ${pad('ID', 20)}  ${pad('STATUS', 8)}  PATH\n`);
        for (const p of projects) {
          const note = p.pathExists ? '' : '  (folder missing)';
          ctx.ui?.write(`${pad(p.name, nameWidth)}  ${pad(p.id, 20)}  ${pad(p.status, 8)}  ${p.path}${note}\n`);
        }
      }
      return { ok: true, projects, total: projects.length };
    } catch (error) {
      return failWithEnvelope(ctx.ui, toProjectEnvelope(error), json);
    }
  },
});
