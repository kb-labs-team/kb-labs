import { defineSystemCommand, throwSystemCommandError, type CommandResult } from '@kb-labs/shared-command-kit';
import { gatewayApiFetch, GatewayApiError } from '@kb-labs/sdk/gateway';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getHostServiceAddress } from '@kb-labs/core-platform';
import { useEnv } from '@kb-labs/sdk';

type Flags = {
  json: { type: 'boolean'; description: string };
  gateway: { type: 'string'; description: string };
};
type HostEntry = {
  hostId: string;
  name: string;
  status: string;
  capabilities: string[];
  hostType?: string;
  lastSeen: number;
  connections: string[];
};
type Result = CommandResult & { hosts: HostEntry[] };

export const workspaceList = defineSystemCommand<Flags, Result>({
  name: 'list',
  scope: 'platform',
  jsonTest: { noSafeValidPath: 'This command queries the configured Gateway for connected Workspace Agents.' },
  description: 'List Workspace Agents connected to a Gateway',
  flags: {
    json: { type: 'boolean', description: 'Output machine-readable JSON' },
    gateway: { type: 'string', description: 'Gateway URL (defaults to saved configuration or platform Gateway)' },
  },
  async handler(ctx, _argv, flags) {
    let gatewayUrl = flags.gateway;
    if (!gatewayUrl) {
      try {
        const config = JSON.parse(readFileSync(join(homedir(), '.kb', 'agent.json'), 'utf8')) as { gatewayUrl?: string };
        gatewayUrl = config.gatewayUrl;
      } catch {
        // Use the configured platform Gateway when no agent configuration exists.
      }
    }
    gatewayUrl ??= getHostServiceAddress('gateway', { KB_GATEWAY_URL: useEnv('KB_GATEWAY_URL') });
    let hosts: HostEntry[];
    try {
      const response = await gatewayApiFetch(`${gatewayUrl}/hosts`);
      if (!response.ok) throwSystemCommandError(`Failed to list hosts: HTTP ${response.status}`, `Check that ${gatewayUrl} is reachable, then retry.`);
      const body = await response.json() as { hosts: HostEntry[] };
      hosts = body.hosts;
    } catch (error) {
      if (error instanceof GatewayApiError) {
        throwSystemCommandError(error.message, `Check that ${gatewayUrl} is reachable and accepts host queries, then retry.`);
      }
      throw error;
    }
    if (flags.json) return { hosts };
    if (hosts.length === 0) {
      ctx.ui?.info('No Workspace Agents connected.');
      return { hosts: [] };
    }
    const ago = (timestamp: number) => {
      const seconds = Math.floor((Date.now() - timestamp) / 1000);
      if (seconds < 60) return `${seconds}s ago`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
      if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
      return `${Math.floor(seconds / 86400)}d ago`;
    };
    const online = hosts.filter((host) => host.status === 'online').length;
    const offline = hosts.filter((host) => host.status === 'offline').length;
    ctx.ui?.success(`${online} online, ${offline} offline (${hosts.length} total)`, {
      sections: [{ header: 'Agents', items: hosts.map((host) => `${host.name}  ${host.status}  ${host.capabilities.join(', ') || '—'}  ${ago(host.lastSeen)}`) }],
    });
    return { hosts };
  },
});
