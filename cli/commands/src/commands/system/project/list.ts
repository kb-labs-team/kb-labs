/** project list — show every registered project. */

import { defineSystemCommand, type CommandResult } from '@kb-labs/shared-command-kit';
import { renderErrorDiagnostics } from '@kb-labs/shared-cli-ui';
import { generateExamples } from '../../../utils/generate-examples';
import type { PlatformDiagnostic } from '@kb-labs/core-platform';
import type { ProjectSummary } from '@kb-labs/core-contracts';
import { listProjects, projectErrorEnvelope } from '@kb-labs/core-project-registry';
import { failWithEnvelope, openRegistry } from './project-support';

type ListFlags = {
  json: { type: 'boolean'; description?: string };
};

export type ProjectListResult = CommandResult & {
  projects?: ProjectSummary[];
  total?: number;
  diagnostics?: PlatformDiagnostic[];
};

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export const projectList = defineSystemCommand<ListFlags, ProjectListResult>({
  name: 'list',
  scope: 'platform',
  jsonTest: { safeArgs: [] },
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
      const { projects, diagnostics } = await listProjects(openRegistry());
      if (projects.length === 0) {
        if (!json) ctx.ui?.write('No projects registered. Add one with: kb project add <path>\n');
      } else if (!json) {
        const nameWidth = Math.max(4, ...projects.map((p) => p.name.length));
        ctx.ui?.write(`${pad('NAME', nameWidth)}  ${pad('ID', 20)}  ${pad('STATUS', 8)}  PATH\n`);
        for (const p of projects) {
          const note = p.pathExists ? '' : '  (folder missing)';
          ctx.ui?.write(`${pad(p.name, nameWidth)}  ${pad(p.id, 20)}  ${pad(p.status, 8)}  ${p.path}${note}\n`);
        }
      }
      if (!json && diagnostics.length > 0) {
        const renderedDiagnostics = renderErrorDiagnostics(diagnostics);
        ctx.ui?.warn('Project registry contains corrupt records.', {
          title: 'Project registry warnings',
          sections: renderedDiagnostics.map((diagnostic, index) => ({
            header: `${diagnostics[index]!.code}`,
            items: [{ text: diagnostic, truncate: 1000 }],
          })),
        });
      }
      return { projects, total: projects.length, diagnostics };
    } catch (error) {
      return failWithEnvelope(projectErrorEnvelope(error));
    }
  },
});
