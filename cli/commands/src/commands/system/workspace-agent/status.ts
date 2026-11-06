import { defineSystemCommand, type CommandResult } from '@kb-labs/shared-command-kit';
import { HostAgentClient } from '@kb-labs/host-agent-client';
import { createTransport } from '@kb-labs/host-agent-transport';

type Flags = { json: { type: 'boolean'; description: string } };
type Result = CommandResult & { running: boolean; connected?: boolean; hostId?: string; gatewayUrl?: string };

export const workspaceStatus = defineSystemCommand<Flags, Result>({
  name: 'status',
  scope: 'platform',
  jsonTest: { noSafeValidPath: 'This command connects to the separately running Workspace Agent process.' },
  description: 'Show Workspace Agent connection status',
  flags: { json: { type: 'boolean', description: 'Output machine-readable JSON' } },
  async handler(ctx, _argv, flags) {
    let status: { connected: boolean; hostId?: string; gatewayUrl?: string; reconnecting?: boolean } | null = null;
    try {
      const client = new HostAgentClient({ transport: createTransport({ mode: 'auto' }), requestTimeout: 3000 });
      await client.connect();
      status = await client.status();
      client.close();
    } catch {
      // An unavailable local IPC endpoint means the separate process is stopped.
    }
    if (!status) {
      if (!flags.json) ctx.ui?.info('Workspace Agent is not running. Start it with: kb-host-agent');
      return { running: false };
    }
    const result = {
      running: true,
      connected: status.connected,
      hostId: status.hostId,
      gatewayUrl: status.gatewayUrl,
    };
    if (flags.json) return result;
    const label = status.connected ? 'connected' : status.reconnecting ? 'reconnecting...' : 'disconnected';
    ctx.ui?.success('Workspace Agent Status', {
      sections: [{ items: [
        `Status:     ${label}`,
        ...(status.hostId ? [`Host ID:    ${status.hostId}`] : []),
        ...(status.gatewayUrl ? [`Gateway:    ${status.gatewayUrl}`] : []),
      ] }],
    });
    return result;
  },
});
