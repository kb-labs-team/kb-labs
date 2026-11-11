/**
 * Hello cron job - runs on schedule
 *
 * SECURITY: This job runs in a sandboxed child process with permissions from manifest
 */

import { defineJob, type JobInput } from '@kb-labs/sdk/jobs';
import { permissions, type PluginHandlerContext } from '@kb-labs/sdk';
import { join, dirname } from 'node:path';

/**
 * Hello job definition with type-safe handler
 *
 * This demonstrates the new defineJob() pattern which provides:
 * - Type safety for handler input/output
 * - Reusable configuration between manifest and handler
 * - Permissions declared alongside the handler
 * - Clean separation of concerns
 */
export const helloJob = defineJob({
  id: 'hello-cron',
  schedule: '*/1 * * * *', // Every minute (for demo)
  describe: 'Says hello every minute and writes to log file (sandboxed)',
  enabled: true,
  priority: 5,
  timeout: 10000,
  retries: 2,
  tags: ['demo', 'hello'],

  // ✅ SECURITY: Permissions для job (запуск в sandbox)
  permissions: permissions.combine(
    permissions.presets.pluginWorkspace('template'), // Доступ к .kb/template/
    {
      quotas: {
        timeoutMs: 10000, // 10 seconds timeout
        memoryMb: 64, // 64 MB memory limit
        cpuMs: 5000, // 5 seconds CPU time
      },
    }
  ),

  /**
   * Job handler - executes in sandbox with ctx.runtime.fs
   */
  async handler(input: JobInput, ctx: PluginHandlerContext) {
    const message = `Hello from sandboxed cron job! Run #${input.runCount} at ${input.executedAt.toISOString()}`;

    // ✅ SECURITY: Use ctx.runtime.fs instead of direct fs access
    const logPath = join('.kb', 'template', 'cron.log');

    try {
      // Create directory if it doesn't exist
      await ctx.runtime.fs.mkdir(dirname(logPath), { recursive: true });

      // Read existing content
      let existingContent = '';
      try {
        existingContent = (await ctx.runtime.fs.readFile(logPath, {
          encoding: 'utf-8',
        })) as string;
      } catch {
        // File doesn't exist yet, ignore
      }

      // Append new message
      await ctx.runtime.fs.writeFile(logPath, existingContent + message + '\n', {
        encoding: 'utf-8',
      });

      ctx.output?.info(message);

      return {
        ok: true,
        message,
        executedAt: input.executedAt.toISOString(),
        runCount: input.runCount,
      };
    } catch (error) {
      ctx.output?.error('Job failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

/**
 * Export handler for manifest reference
 *
 * The manifest references this via './jobs/hello.js#run'
 * JobsManager will import and execute this function in sandbox
 */
export const run = helloJob.handler;
