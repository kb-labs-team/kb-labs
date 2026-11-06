import { defineCommand, type CommandResult, type PluginCommandContextV3 } from '@kb-labs/sdk';

interface CaptureSnapshotFlags {
  'workspace-id'?: string;
  'environment-id'?: string;
  namespace?: string;
  'source-path'?: string;
}

interface CaptureSnapshotInput {
  argv: string[];
  flags: CaptureSnapshotFlags;
}

interface CaptureSnapshotResult {
  snapshotId: string;
}

export default defineCommand<unknown, CaptureSnapshotInput, CaptureSnapshotResult>({
  id: 'infra-worker:capture-snapshot',
  description: 'Capture snapshot from workspace/environment.',
  handler: {
    async execute(
      ctx: PluginCommandContextV3<unknown>,
      input: CaptureSnapshotInput
    ): Promise<CommandResult<CaptureSnapshotResult>> {
      const flags = input.flags;
      const snapshot = await ctx.api.snapshot.capture({
        workspaceId: flags['workspace-id'],
        environmentId: flags['environment-id'],
        namespace: flags.namespace,
        sourcePath: flags['source-path'],
      });

      const result: CaptureSnapshotResult = { snapshotId: snapshot.snapshotId };
      ctx.ui.success(`Snapshot captured: ${result.snapshotId}`);

      return result;
    },
  },
});
