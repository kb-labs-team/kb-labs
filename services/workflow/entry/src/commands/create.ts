import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineCommand, handleError, type CLIInput, type CommandResult, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { workflowCommandError } from './errors.js';

import type { CreateFlags } from '@kb-labs/workflow-contracts';

const EXAMPLE = `name: hello
version: 1.0.0
description: A local workflow example
on:
  manual: true
jobs:
  hello:
    runsOn: local
    steps:
      - name: Print marker
        id: hello
        uses: builtin:shell
        with:
          command: echo hello-workflow
`;

export default defineCommand<unknown, CLIInput<CreateFlags>, unknown>({
  id: 'workflow:create',
  description: 'Create a runnable local workflow example',
  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<CreateFlags>): Promise<CommandResult> {
      const output = join(process.cwd(), '.kb', 'workflows', 'hello.yml');
      try {
        await mkdir(join(process.cwd(), '.kb', 'workflows'), { recursive: true });
        await writeFile(output, EXAMPLE, { encoding: 'utf8', flag: 'wx' });
        const result = { path: '.kb/workflows/hello.yml' };
        if (input.flags.json) { return result; }
        else {
          ctx.ui?.success?.('Created .kb/workflows/hello.yml');
          ctx.ui?.write?.('Next: kb workflow lint && kb workflow run --workflow-id=hello\n');
        }
        return result;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
          return workflowCommandError('KB_RUNTIME_COMMAND_FAILED', 'Workflow file already exists: .kb/workflows/hello.yml.', 'Rename the existing workflow file, then retry `kb workflow create`.', {});
        }
        return handleError(error);
      }
    },
  },
});
