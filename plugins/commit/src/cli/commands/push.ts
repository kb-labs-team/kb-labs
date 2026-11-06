/**
 * commit:push command
 * Push commits to remote
 */

import { defineCommand, useLoader, findRepoRoot, handleError, type PluginCommandContextV3 } from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import { pushCommits } from '../../core/index.js';
import type { PushOutput } from '../../contracts/index.js';

type PushInput = {
  force?: boolean;
  json?: boolean;
};

type PushResult = CommandResult<PushOutput>;

export default defineCommand({
  id: 'commit:push',
  description: 'Push commits to remote',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: PushInput): Promise<PushResult> {
      const startTime = Date.now();
      const cwd = (await findRepoRoot(ctx.cwd || process.cwd())) ?? process.cwd();

      // Push
      const pushLoader = useLoader('Pushing commits...');
      pushLoader.start();
      let result;
      try {
        result = await pushCommits(cwd, { force: input.force });
      } catch (err) {
        pushLoader.fail('Push failed');
        return handleError(err);
      }

      // Output
      const output: PushOutput = {
        success: result.success,
        remote: result.remote,
        branch: result.branch,
        commits: result.commitsPushed,
      };

      if (result.success) {
        if (result.commitsPushed > 0) {
          pushLoader.succeed(`Pushed ${result.commitsPushed} commit(s) to ${result.remote}/${result.branch}`);
        } else {
          pushLoader.succeed('Nothing to push - already up to date');
        }
      } else {
        pushLoader.fail(`Failed to push: ${result.error}`);
      }

      if (input.json) {
        return output;
      } else if (!result.success) {
        // Show error details

      } else if (result.commitsPushed > 0) {
        // Show success details
        ctx.ui?.success?.('Push Successful', {
          sections: [{
            header: 'Details',
            items: [
              `Commits pushed: ${result.commitsPushed}`,
              `Remote: ${result.remote || 'origin'}`,
              `Branch: ${result.branch || 'main'}`,
              'Status: ✅ Up to date',
            ],
          }],
        });
      }

      return result.success ? output : { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Commit push failed', hint: 'Review the push output, then rerun `kb commit publish`.' } };
    },
  },
});
