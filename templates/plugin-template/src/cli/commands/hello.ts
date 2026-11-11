/**
 * Hello Command - V3 Migration
 *
 * Migrated from V2 to V3 plugin architecture.
 * Demonstrates new PluginContextV3 with improved UI API and structured output.
 *
 * Key changes from V2:
 * 1. Platform dependency: @kb-labs/sdk; plugin contracts live in this package
 * 2. Handler is now an object with execute method
 * 3. Input is a single object { argv, flags } instead of separate parameters
 * 4. Context is PluginContextV3 with new UI and runtime APIs
 * 5. Uses ctx.api.output.result() for structured output
 * 6. Returns { exitCode } instead of { ok, result }
 */

import { defineCommand, TimingTracker, type PluginContextV3, type CommandResult } from '@kb-labs/sdk';

// V3: Define flags inline (no external deps)
interface HelloFlags {
  name?: string;
  json?: boolean;
}

// V3: Input structure with argv and flags
interface HelloInput {
  argv: string[];
  flags: HelloFlags;
}

interface HelloResult {
  message: string;
  target: string;
}

/**
 * Simple greeting creator (inline, no external deps)
 */
function createGreeting(name?: string): HelloResult {
  const target = name || 'World';
  return {
    message: `Hello, ${target}!`,
    target,
  };
}

/**
 * V3 Hello Command
 */
export default defineCommand<unknown, HelloInput, HelloResult>({
  id: 'plugin-template:hello',
  description: 'Print a hello message from the plugin template',

  handler: {
    async execute(
      ctx: PluginContextV3<unknown>,
      input: HelloInput
    ): Promise<CommandResult<HelloResult>> {
      const tracker = new TimingTracker();
      const flags = input.flags;

      // Trace: command started
      ctx.trace.addEvent('hello.start', { name: flags.name });

      tracker.checkpoint('init');

      // Core logic
      const greeting = createGreeting(flags.name);

      tracker.checkpoint('greeting');

      // Trace: command processing
      ctx.trace.addEvent('hello.process', { message: greeting.message });

      tracker.checkpoint('processing');

      // Output
      if (flags.json) {
        ctx.ui.json(greeting);
      } else {
        ctx.ui.success(greeting.message, {
          title: 'Hello Command',
          sections: [
            {
              header: 'Details',
              items: [
                `Target: ${greeting.target}`,
                `Mode: ${flags.json ? 'JSON' : 'Interactive'}`,
              ],
            },
          ],
          timing: tracker.total(),
        });
      }

      // Trace: command completed
      ctx.trace.addEvent('hello.complete');

      // Return structured result
      // Standard metadata (executedAt, duration, pluginId, etc.) will be injected automatically by runtime
      return greeting;
    },
  },
});
