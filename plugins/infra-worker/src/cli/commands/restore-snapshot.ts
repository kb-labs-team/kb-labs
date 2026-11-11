import { defineCommand, type CommandResult, type PluginCommandContextV3 } from '@kb-labs/sdk';

interface RestoreSnapshotFlags {
  'snapshot-id'?: string;
  'workspace-id'?: string;
  'environment-id'?: string;
  'target-path'?: string;
  overwrite?: boolean;
}

interface RestoreSnapshotInput {
  argv: string[];
  flags: RestoreSnapshotFlags;
}

interface RestoreSnapshotResult {
  snapshotId: string;
  restoredAt: string;
}

export default defineCommand<unknown, RestoreSnapshotInput, RestoreSnapshotResult>({
  id: 'infra-worker:restore-snapshot',
  description: 'Restore snapshot to workspace/environment.',
  handler: {
    async execute(
      ctx: PluginCommandContextV3<unknown>,
      input: RestoreSnapshotInput
    ): Promise<CommandResult<RestoreSnapshotResult>> {
      const flags = input.flags;
      if (!flags['snapshot-id']) {
        throw new Error('Missing required flag: --snapshot-id');
      }

      const restored = await ctx.api.snapshot.restore({
        snapshotId: flags['snapshot-id'],
        workspaceId: flags['workspace-id'],
        environmentId: flags['environment-id'],
        targetPath: flags['target-path'],
        overwrite: flags.overwrite,
      });

      const result: RestoreSnapshotResult = {
        snapshotId: restored.snapshotId,
        restoredAt: restored.restoredAt,
      };
      ctx.ui.success(`Snapshot restored: ${result.snapshotId}`);

      return result;
    },
  },
});
