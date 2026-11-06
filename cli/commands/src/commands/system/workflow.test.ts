import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createErrorEnvelope } from '@kb-labs/core-platform';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import { noopTraceContext, noopUI } from '@kb-labs/plugin-contracts';
import { registry } from '../../registry/service.js';
import { registerBuiltinSystemCommands } from '../../utils/register.js';
import { workflowCommands, workflowServiceCommands } from '@kb-labs/workflow-entry';
import { workflowGroup } from './workflow.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('built-in workflow commands', () => {
  it('registers workflow subcommands in the system command registry', () => {
    registerBuiltinSystemCommands();

    expect(registry.resolve(['workflow', 'runs', 'list']).type).toBe('system-cmd');
    expect(registry.resolve(['workflow', 'defs', 'view']).type).toBe('system-cmd');
  });

  it('registers every declared workflow command from the same service catalog', () => {
    const registered: string[] = [];
    const visit = (group: typeof workflowGroup, prefix: string): void => {
      const groupPath = prefix ? `${prefix} ${group.name}` : group.name;
      registered.push(...group.commands.map((command) => `${groupPath} ${command.name}`));
      for (const subgroup of group.subgroups ?? []) visit(subgroup, groupPath);
    };
    visit(workflowGroup, '');
    const declared = Object.values(workflowServiceCommands.commands).map((command) => command.name);
    expect(registered.sort()).toEqual(declared.sort());
    expect(Object.keys(workflowCommands).sort()).toEqual(Object.keys(workflowServiceCommands.commands).sort());
  });

  it('derives the workflow run leaf command from the service declaration', () => {
    registerBuiltinSystemCommands();
    const leaf = workflowServiceCommands.commands.workflowRun.name.split(' ').at(-1);
    expect(leaf).toBeDefined();
    expect(registry.resolve(['workflow', leaf!]).type).toBe('system-cmd');
  });

  it('serializes a workflow handler failure through the shared CLI command boundary', async () => {
    registerBuiltinSystemCommands();
    const route = registry.resolve(['workflow', 'lint']);
    expect(route.type).toBe('system-cmd');
    if (route.type !== 'system-cmd') throw new Error('workflow lint is not a built-in system command');

    const directory = await mkdtemp(join(tmpdir(), 'kb-workflow-cli-boundary-'));
    tempDirectories.push(directory);
    const workflowFile = join(directory, 'invalid.yml');
    await writeFile(workflowFile, 'name: invalid\nversion: 1.0.0\non:\n  manual: true\njobs:\n  main:\n    runsOn: local\n    steps: []\n');
    const output: unknown[] = [];
    const ctx: PluginContextV3 = {
      host: 'cli',
      requestId: 'workflow-boundary-test',
      pluginId: '@kb-labs/system',
      pluginVersion: '1.0.0',
      cwd: process.cwd(),
      ui: { ...noopUI, json: (value: unknown) => output.push(value) },
      platform: {} as PluginContextV3['platform'],
      runtime: {} as PluginContextV3['runtime'],
      api: {} as PluginContextV3['api'],
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
      trace: noopTraceContext,
    };

    const exitCode = await route.cmd.run(ctx, [], { json: true, path: workflowFile });

    expect(exitCode).toBe(2);
    const cataloguedError = createErrorEnvelope('KB_RUNTIME_INPUT_INVALID');
    expect(output).toMatchObject([{
      ok: false,
      error: {
        code: cataloguedError.code,
        area: cataloguedError.area,
        severity: cataloguedError.severity,
        retryable: cataloguedError.retryable,
        diagnostics: [expect.objectContaining({ severity: 'error' })],
      },
    }]);
  });
});
