import { defineSystemCommand, throwSystemCommandError, type CommandResult } from '@kb-labs/shared-command-kit';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { join, resolve, normalize } from 'node:path';
import { homedir, hostname } from 'node:os';
import { gatewayApiFetch, GatewayApiError } from '@kb-labs/sdk/gateway';

type Flags = {
  gateway: { type: 'string'; description: string };
  name: { type: 'string'; description: string };
  workspace: { type: 'array'; items: 'string'; description: string };
  namespace: { type: 'string'; description: string };
  'dry-run': { type: 'boolean'; description: string };
  json: { type: 'boolean'; description: string };
};

type Result = CommandResult & {
  configPath?: string;
  hostId?: string;
  clientId?: string;
  summary?: string;
  operations?: Array<{ type: 'create'; resource: string; details: Record<string, unknown> }>;
};

export const workspaceRegister = defineSystemCommand<Flags, Result>({
  name: 'register',
  scope: 'platform',
  jsonTest: { noSafeValidPath: 'This command registers a machine and writes credentials.' },
  description: 'Register this machine with a Platform Gateway',
  flags: {
    gateway: { type: 'string', description: 'Gateway URL (http:// or https://)' },
    name: { type: 'string', description: 'Display name for this host (default: hostname)' },
    workspace: { type: 'array', items: 'string', description: 'Workspace paths this agent may access' },
    namespace: { type: 'string', description: 'Namespace ID (default: default)' },
    'dry-run': { type: 'boolean', description: 'Show the registration operation without contacting the Gateway or writing credentials' },
    json: { type: 'boolean', description: 'Output machine-readable JSON' },
  },
  async handler(ctx, _argv, flags) {
    const gatewayUrl = (flags.gateway ?? '').replace(/\/$/, '');
    const paths = flags.workspace ?? [process.cwd()];
    const workspacePaths: string[] = [];
    for (const path of paths) {
      const resolved = resolve(normalize(path));
      let pathStat: Awaited<ReturnType<typeof stat>>;
      try {
        pathStat = await stat(resolved);
      } catch {
        throwSystemCommandError(`Workspace path does not exist or is not a directory: ${resolved}`, 'Pass an existing directory with --workspace, then retry.');
      }
      if (!pathStat.isDirectory()) {
        throwSystemCommandError(`Workspace path does not exist or is not a directory: ${resolved}`, 'Pass an existing directory with --workspace, then retry.');
      }
      workspacePaths.push(resolved);
    }
    if (!gatewayUrl) {
      throwSystemCommandError('--gateway is required', 'Run `kb workspace register --help` to review valid inputs, then retry with --gateway.');
    }
    if (!gatewayUrl.startsWith('http://') && !gatewayUrl.startsWith('https://')) {
      throwSystemCommandError('Invalid gateway URL — must start with http:// or https://', 'Pass a Gateway URL beginning with http:// or https://, then retry.');
    }
    const configPath = join(homedir(), '.kb', 'agent.json');
    if (flags['dry-run']) {
      const name = flags.name ?? '(this machine)';
      const result = {
        summary: `Register workspace agent with Gateway ${gatewayUrl || '(unknown)'}`,
        operations: [
          { type: 'create' as const, resource: 'agent-credentials', details: { name, gateway: gatewayUrl } },
          { type: 'create' as const, resource: 'file', details: { path: '~/.kb/agent.json' } },
        ],
      };
      if (!flags.json) {
        ctx.ui?.info(`Dry run: ${result.summary}`);
      }
      return result;
    }

    ctx.ui?.info(`Registering with Gateway: ${gatewayUrl}`);
    let response: Response;
    try {
      response = await gatewayApiFetch(`${gatewayUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: flags.name ?? hostname(),
          namespaceId: flags.namespace ?? 'default',
          capabilities: ['filesystem', 'git', 'execution', 'search', 'shell'],
        }),
      });
    } catch (error) {
      const message = error instanceof GatewayApiError ? error.message : `Failed to reach Gateway: ${error instanceof Error ? error.message : String(error)}`;
      throwSystemCommandError(message, `Check that ${gatewayUrl} is reachable and accepts workspace registration, then retry.`);
    }
    if (!response.ok) {
      throwSystemCommandError(`Gateway returned HTTP ${response.status}.`, `Check that ${gatewayUrl} accepts workspace registration, then retry.`);
    }
    let data: { clientId?: string; clientSecret?: string; hostId?: string };
    try {
      data = await response.json() as typeof data;
    } catch {
      throwSystemCommandError('Gateway response is not valid JSON', 'Check the Gateway response and retry registration.');
    }
    if (!data.clientId || !data.clientSecret || !data.hostId) {
      throwSystemCommandError('Gateway response is missing required fields (clientId, clientSecret, hostId)', 'Check the Gateway registration endpoint and retry.');
    }
    if (!/^[A-Za-z0-9_\-+/=]{16,}$/.test(data.clientSecret)) {
      throwSystemCommandError('Gateway returned an invalid client secret (unexpected format)', 'Check the Gateway registration endpoint and retry.');
    }
    await mkdir(join(homedir(), '.kb'), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      hostId: data.hostId,
      gatewayUrl,
      namespaceId: flags.namespace ?? 'default',
      hostType: 'local',
      workspacePaths,
      execution: { mode: 'in-process', timeoutMs: 120_000 },
    }, null, 2), { mode: 0o600 });
    const result = { configPath, hostId: data.hostId, clientId: data.clientId };
    if (flags.json) return result;
    ctx.ui?.success('Workspace Agent registered', {
      sections: [{ items: [
        `Host ID:    ${data.hostId}`,
        `Client ID:  ${data.clientId}`,
        `Gateway:    ${gatewayUrl}`,
        `Namespace:  ${flags.namespace ?? 'default'}`,
        `Workspaces: ${workspacePaths.join(', ')}`,
        `Config:     ${configPath}`,
      ] }],
      hint: 'Start the Workspace Agent process with `kb-host-agent`.',
    });
    return result;
  },
});
