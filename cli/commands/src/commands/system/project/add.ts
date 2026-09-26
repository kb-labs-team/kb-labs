/**
 * project add — register a folder in the machine-level project registry.
 *
 * A folder that already has `.kb/` is picked up as-is. A folder without
 * `.kb/` is NOT initialized silently: the command returns a typed
 * `initializationRequired` result, unless `--init` is passed, in which case
 * the minimal `.kb/` is created through the same routine `kb init` uses
 * (`initWorkspaceConfig` from @kb-labs/core-config).
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { defineSystemCommand, type CommandResult } from '@kb-labs/shared-command-kit';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import { initWorkspaceConfig } from '@kb-labs/core-config';
import { canonicalizeProjectPath } from '@kb-labs/core-project-registry';
import { createErrorEnvelope } from '@kb-labs/core-platform';
import type { ProjectRecord } from '@kb-labs/core-contracts';
import { generateExamples } from '../../../utils/generate-examples';
import { failWithEnvelope, openRegistry, toProjectEnvelope } from './project-support';

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

async function hasKbDir(projectPath: string): Promise<boolean> {
  try {
    return (await fs.stat(join(projectPath, '.kb'))).isDirectory();
  } catch {
    return false;
  }
}

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
      const input = resolve(getContextCwd(ctx), argv[0] ?? '.');
      const canonical = await canonicalizeProjectPath(input);
      const registry = openRegistry();
      const declared = await hasKbDir(canonical);

      if (!declared && !init) {
        const nextStep = `kb project add ${canonical} --init`;
        const payload = { ok: false as const, initializationRequired: true, path: canonical, nextStep };
        if (json) {
          ui?.json(payload);
        } else {
          ui?.warn(`${canonical} has no .kb/ directory, so it was not registered.`);
          ui?.write(`Initialize and register it in one step: ${nextStep}\n`);
        }
        return { ...payload, error: 'Project initialization required' };
      }

      // Validate the registration (duplicate, name) before touching the folder.
      const planned = await registry.add(canonical, { name: flags.name, dryRun: true });

      let created: string[] = [];
      const needsInit = !declared;
      if (needsInit) {
        // initWorkspaceConfig looks upward for an existing config; never let it edit a parent's.
        const probe = await initWorkspaceConfig({ cwd: canonical, dryRun: true });
        const escapes = probe.actions.some((a) => {
          const rel = relative(join(canonical, '.kb'), resolve(a.path));
          return rel.startsWith('..') || isAbsolute(rel);
        });
        if (escapes) {
          return failWithEnvelope(
            ui,
            createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', {
              cause: 'An enclosing folder already owns a .kb/ configuration; initializing here would modify it.',
            }),
            json,
          );
        }
        if (!dryRun) {
          created = (await initWorkspaceConfig({ cwd: canonical })).created;
        }
      }

      if (dryRun) {
        const payload = {
          ok: true as const,
          dryRun: true,
          project: planned.project,
          wouldInitialize: needsInit,
        };
        if (json) {
          ui?.json(payload);
        } else {
          ui?.info(`Dry run: would register ${planned.project.name} (${planned.project.id}) at ${canonical}`);
          if (needsInit) {
            ui?.write('Dry run: would create .kb/ with a minimal configuration.\n');
          }
        }
        return payload;
      }

      const { project } = await registry.add(canonical, { name: flags.name });
      const payload = { ok: true as const, project, initialized: needsInit, created };
      if (json) {
        ui?.json(payload);
      } else {
        ui?.success(`Registered ${project.name} (${project.id})`);
        ui?.write(`  path: ${project.path}\n`);
        if (needsInit) {
          ui?.write(`  created: ${created.join(', ') || '.kb/'}\n`);
        }
      }
      return payload;
    } catch (error) {
      return failWithEnvelope(ui, toProjectEnvelope(error), json);
    }
  },
});
