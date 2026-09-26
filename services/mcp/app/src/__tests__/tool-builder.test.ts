import { describe, it, expect, vi } from 'vitest';
import type { ManifestV3, CliCommandDecl } from '@kb-labs/plugin-contracts';
import type { RegistrySnapshotManifestEntry } from '@kb-labs/core-registry';
import { filterTools, validateManifests } from '../mcp/tool-builder.js';
import type { Permits } from '../mcp/authz.js';

const allow: Permits = () => true;
const deny: Permits = () => false;
const onlyRead: Permits = (op) => op === 'read';

function cmd(path: string, operationType: CliCommandDecl['operationType'], extra: Partial<CliCommandDecl> = {}): CliCommandDecl {
  return {
    path,
    describe: `does ${path}`,
    handler: `./dist/commands/${path.replace(/\s+/g, '-')}.js`,
    operationType,
    ...extra,
  };
}

function entry(pluginId: string, commands: CliCommandDecl[], version = '1.2.3'): RegistrySnapshotManifestEntry {
  const manifest: ManifestV3 = {
    schema: 'kb.plugin/3',
    id: pluginId,
    version,
    cli: { commands },
  };
  return {
    pluginId,
    manifest,
    pluginRoot: `/plugins/${pluginId}`,
    source: { kind: 'local', path: `/plugins/${pluginId}` },
    packageName: pluginId,
    scope: 'platform',
    origin: 'node_modules',
    manifestPath: `/plugins/${pluginId}/dist/manifest.json`,
    manifestKind: 'static',
  };
}

describe('filterTools', () => {
  it('returns empty for an empty snapshot', () => {
    expect(filterTools({ manifests: [] }, allow)).toEqual([]);
  });

  it('includes a command the identity is permitted to use', () => {
    const tools = filterTools({ manifests: [entry('mind', [cmd('mind search', 'read')])] }, allow);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('mind__mind_search');
    expect(tools[0]!.pluginId).toBe('mind');
    expect(tools[0]!.handlerPath).toBe('./dist/commands/mind-search.js');
    expect(tools[0]!.pluginRoot).toBe('/plugins/mind');
    expect(tools[0]!.version).toBe('1.2.3');
    expect(tools[0]!.operationType).toBe('read');
  });

  it('excludes commands the PDP denies', () => {
    const tools = filterTools({ manifests: [entry('wf', [cmd('workflow deploy', 'execute')])] }, deny);
    expect(tools).toHaveLength(0);
  });

  it('filters by operationType through the permits predicate', () => {
    const snap = { manifests: [entry('wf', [cmd('workflow run', 'read'), cmd('workflow deploy', 'execute')])] };
    const tools = filterTools(snap, onlyRead);
    expect(tools.map((t) => t.name)).toEqual(['wf__workflow_run']);
  });

  it('namespaces tool names by pluginId to prevent collisions', () => {
    const snap = {
      manifests: [
        entry('pluginA', [cmd('run task', 'read')]),
        entry('pluginB', [cmd('run task', 'read')]),
      ],
    };
    expect(filterTools(snap, allow).map((t) => t.name)).toEqual(['pluginA__run_task', 'pluginB__run_task']);
  });

  it('sanitizes scoped npm package names in tool names', () => {
    // Real pluginIds look like "@kb-labs/policy". The @ and / must be stripped
    // so tool names match /^[a-z0-9-]+__[a-z0-9_]+$/ (MCP name constraint).
    const snap = { manifests: [entry('@kb-labs/policy', [cmd('policy detect', 'read')])] };
    const [tool] = filterTools(snap, allow);
    expect(tool!.name).toBe('kb-labs-policy__policy_detect');
    expect(tool!.name).toMatch(/^[a-z0-9-]+__[a-z0-9_]+$/);
  });

  it('ignores manifests without cli commands', () => {
    const manifest: ManifestV3 = { schema: 'kb.plugin/3', id: 'nocli', version: '1.0.0' };
    const e: RegistrySnapshotManifestEntry = {
      pluginId: 'nocli',
      manifest,
      pluginRoot: '/p',
      source: { kind: 'local', path: '/p' },
      packageName: 'nocli',
      scope: 'platform',
      origin: 'node_modules',
      manifestPath: '/p/dist/manifest.json',
      manifestKind: 'static',
    };
    expect(filterTools({ manifests: [e] }, allow)).toEqual([]);
  });

  it('delegates input schema generation to generateCommandSchema', async () => {
    const mod = await import('@kb-labs/cli-commands');
    const spy = vi.spyOn(mod, 'generateCommandSchema').mockReturnValue({ type: 'object' });
    const tools = filterTools({ manifests: [entry('p', [cmd('do it', 'read')])] }, allow);
    expect(spy).toHaveBeenCalledOnce();
    expect(tools[0]!.inputSchema).toEqual({ type: 'object' });
    spy.mockRestore();
  });

  it('passes flags through to the generated schema', () => {
    const command = cmd('mind search', 'read', {
      flags: [{ name: 'text', type: 'string', description: 'query', required: true }],
    });
    const tools = filterTools({ manifests: [entry('mind', [command])] }, allow);
    const schema = tools[0]!.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(schema.properties.text).toBeDefined();
    expect(schema.required).toContain('text');
  });

  it('skips a command with no "path" field instead of throwing', () => {
    // Manifests are untyped JS/JSON at runtime — a scaffolded plugin can ship
    // an old-shape command (id/group, no path) that bypasses TS entirely.
    // Regression for: this used to throw inside `${undefined}.trim()` and take
    // down the whole tools/list response for every tool in the request.
    const malformed = { id: 'hello', describe: 'says hello', handler: './dist/commands/hello.js' } as unknown as CliCommandDecl;
    const good = cmd('mind search', 'read');
    expect(() => filterTools({ manifests: [entry('notifier-test', [malformed, good])] }, allow)).not.toThrow();
    const tools = filterTools({ manifests: [entry('notifier-test', [malformed, good])] }, allow);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('notifier-test__mind_search');
  });
});

describe('validateManifests', () => {
  it('returns no diagnostics for a well-formed snapshot', () => {
    const snap = { manifests: [entry('mind', [cmd('mind search', 'read')])] };
    expect(validateManifests(snap)).toEqual([]);
  });

  it('reports a command missing "path", independent of any permits', () => {
    const malformed = { id: 'hello', describe: 'says hello', handler: './dist/commands/hello.js' } as unknown as CliCommandDecl;
    const snap = { manifests: [entry('notifier-test', [malformed])] };
    const diagnostics = validateManifests(snap);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ pluginId: 'notifier-test', commandId: 'hello' });
    expect(diagnostics[0]!.error).toMatch(/path/);
  });

  it('does not report commands that build successfully', () => {
    const snap = { manifests: [entry('mind', [cmd('mind search', 'read'), cmd('mind ask', 'read')])] };
    expect(validateManifests(snap)).toEqual([]);
  });
});
