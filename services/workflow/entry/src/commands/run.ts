/**
 * workflow:job-run command - Submit a raw job for execution
 */

import { defineCommand, handleError, type CLIInput, type PluginCommandContextV3, useLoader , type CommandResult} from '@kb-labs/sdk';
import { WorkflowDaemonClient } from '../http-client.js';
import { workflowCommandError } from './errors.js';

export interface RunFlagsInput {
  json?: boolean;
  handler?: string;
  input?: string;
  priority?: number;
  wait?: boolean;
}

export default defineCommand<unknown, CLIInput<RunFlagsInput>, unknown>({
  id: 'workflow:job-run',
  description: 'Submit a raw job for execution',

  handler: {
    // eslint-disable-next-line sonarjs/cognitive-complexity -- Workflow execution with input parsing, validation, wait mode (polling + websocket logs), JSON/human output, and error handling
    async execute(ctx: PluginCommandContextV3, input: CLIInput<RunFlagsInput>): Promise<CommandResult> {
      const outputJson = input.flags.json ?? false;
      const handler = input.flags.handler;
      const inputStr = input.flags.input;
      const priority = input.flags.priority ?? 5;
      const wait = input.flags.wait ?? false;

      if (!handler) {
        return workflowCommandError(
          'KB_RUNTIME_INPUT_INVALID',
          'Missing required flag: --handler.',
          'Run `kb workflow job run --help` to see the required flags.',
          { details: { field: 'handler' } },
        );
      }

      // Parse input JSON if provided
      let parsedInput: unknown;
      if (inputStr) {
        try {
          parsedInput = JSON.parse(inputStr);
        } catch {
          return workflowCommandError(
            'KB_RUNTIME_INPUT_INVALID',
            'The --input value is not valid JSON.',
            'Pass valid JSON with `--input`, then retry `kb workflow job run`.',
            { details: { field: 'input' } },
          );
        }
      }

      try {
        const client = new WorkflowDaemonClient();

        const loader = useLoader('Submitting job...');
        loader.start();

        const result = await client.submitJob({
          handler,
          input: parsedInput,
          priority,
        });

        loader.succeed('Job submitted');

        if (wait) {
          const waitLoader = useLoader('Waiting for job completion...');
          waitLoader.start();

          // Poll job status until completion
          let maxAttempts = 60; // 60 * 2s = 2 minutes max
          // IMPORTANT: This is a polling loop, must run sequentially
          while (maxAttempts > 0) {
            await new Promise<void>(resolve => { setTimeout(resolve, 2000); }); // Wait 2s

            const status = await client.getJobStatus(result.id);

            if (status.status === 'success') {
              result.status = status.status;
              waitLoader.succeed('Job completed');
              break;
            } else if (['failed', 'cancelled', 'skipped', 'dlq'].includes(status.status)) {
              waitLoader.fail('Job failed');
              return workflowCommandError(
                'KB_RUNTIME_COMMAND_FAILED',
                `Job ${result.id} ended with status ${status.status}.`,
                `Inspect the result with: kb workflow job status ${result.id}`,
                { cause: status.error },
              );
            }

            maxAttempts--;
          }

          if (maxAttempts === 0) {
            waitLoader.fail('Timeout waiting for job completion');
            return workflowCommandError(
              'KB_RUNTIME_COMMAND_FAILED',
              `Timed out waiting for job ${result.id} to finish.`,
              `Inspect the job with: kb workflow job status ${result.id}`,
              {},
            );
          }
        }

        if (outputJson) {
          return result;
        } else {
          const resultItems = [
            `Job ID: ${result.id}`,
            `Status: ${result.status}`,
            `Handler: ${handler}`,
            `Priority: ${priority}`,
          ];

          if (parsedInput) {
            resultItems.push(`Input: ${JSON.stringify(parsedInput)}`);
          }

          ctx.ui?.success?.('Job Submitted Successfully', {
            title: 'Workflow Engine',
            sections: [{ header: 'Details', items: resultItems }],
          });
        }

        return undefined;
      } catch (error) {
        return handleError(error);
      }
    },
  },
});
