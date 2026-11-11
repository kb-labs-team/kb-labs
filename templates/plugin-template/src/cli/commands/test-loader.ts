/**
 * Test Loader Command - V3 Migration
 *
 * Demonstrates UI loader/spinner functionality with V3 plugin architecture.
 *
 * Shows examples of:
 * - useLoader() hook - Spinner with start/stop/update/succeed/fail
 * - Single continuous loader - For quick tasks (loading, processing)
 * - Multi-stage progress - For complex operations with multiple steps
 * - Different scenarios: success, failure, rapid updates
 */

/* eslint-disable no-await-in-loop -- Sequential delays required for UI demonstration */

/**
 *
 * Key V3 changes:
 * 1. Only dependency: @kb-labs/sdk
 * 2. Handler is object with execute method
 * 3. Input is single { argv, flags } object
 * 4. Context is PluginContextV3
 * 5. Returns { ok, result } from the canonical CommandResult contract
 */

import { defineCommand, useLoader, type PluginContextV3, type CommandResult } from '@kb-labs/sdk';

// V3: Define types inline (no external contracts)
interface LoaderFlags {
  duration?: number;
  fail?: boolean;
  stages?: number;
}

interface LoaderInput {
  argv: string[];
  flags: LoaderFlags;
}

interface LoaderResult {
  completed: boolean;
  stagesRun: number;
}

export default defineCommand<unknown, LoaderInput, LoaderResult>({
  id: 'plugin-template:test-loader',
  description: 'Test UI loader/spinner functionality with various scenarios',

  handler: {
    async execute(
      ctx: PluginContextV3<unknown>,
      input: LoaderInput
    ): Promise<CommandResult<LoaderResult>> {
      const flags = input.flags;
    const duration = flags.duration ?? 2000;
    const shouldFail = flags.fail ?? false;
    const stagesCount = flags.stages ?? 3;

    ctx.ui?.info('', {
      title: '🧪 Testing Loader/Spinner functionality',
      sections: [{
        items: [
          `Duration per stage: ${duration}ms`,
          `Stages: ${stagesCount}`,
          `Fail scenario: ${shouldFail ? 'yes' : 'no'}`,
        ]
      }]
    });

    // ===== 1. Single Continuous Loader (no stages) =====
    ctx.ui.info('\n1. Single Continuous Loader (ideal for quick tasks)');

    const loader = useLoader('Loading data...');
    loader.start();

    await sleep(duration / 5);

    loader.update({ text: 'Processing items...' });
    await sleep(duration / 5);

    loader.update({ text: 'Validating results...' });
    await sleep(duration / 5);

    loader.update({ text: 'Finalizing...' });
    await sleep(duration / 5);

    loader.succeed('Data loaded successfully!');

    await sleep(500);

    // ===== 2. Multi-Stage Progress Test =====
    ctx.ui.info('\n2. Multi-Stage Progress (for complex operations)');

    for (let i = 1; i <= stagesCount; i++) {
      const spinner = useLoader(`Stage ${i}/${stagesCount}: Starting...`);
      spinner.start();

      await sleep(duration / 4);
      spinner.update({ text: `Stage ${i}/${stagesCount}: 25% complete` });

      await sleep(duration / 4);
      spinner.update({ text: `Stage ${i}/${stagesCount}: 50% complete` });

      await sleep(duration / 4);
      spinner.update({ text: `Stage ${i}/${stagesCount}: 75% complete` });

      await sleep(duration / 4);

      // Complete or fail stage
      if (shouldFail && i === Math.floor(stagesCount / 2)) {
        spinner.fail(`Stage ${i}/${stagesCount}: Failed!`);
        break;
      } else {
        spinner.succeed(`Stage ${i}/${stagesCount}: Complete!`);
      }
    }

    await sleep(500);

    // ===== Final Result =====
    const result = {
      completed: !shouldFail || stagesCount === 0,
      stagesRun: shouldFail ? Math.floor(stagesCount / 2) : stagesCount,
    };

    // Final summary
    ctx.ui.success(`\nLoader Test Complete - ${result.completed ? 'Success' : 'Failed'}`);

      return result;
    }
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
