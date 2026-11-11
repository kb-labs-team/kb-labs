import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRoot } from '../src/doctor/scan.js';

async function makeScaffoldedPlugin(
  pluginsRoot: string,
  name: string,
  opts: { withDist?: boolean } = {},
) {
  const pluginRoot = join(pluginsRoot, name);
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, 'package.json'),
    JSON.stringify({
      name: `@kb-labs/${name}`,
      version: '0.1.0',
      kb: { manifest: './dist/manifest.js' },
      dependencies: { '@kb-labs/sdk': 'workspace:*' },
    }),
  );
  if (opts.withDist) {
    await mkdir(join(pluginRoot, 'dist'), { recursive: true });
    await writeFile(join(pluginRoot, 'dist', 'manifest.js'), 'export default {};');
  }
  return pluginRoot;
}

async function writeLock(
  workspaceRoot: string,
  installed: Record<string, { resolvedPath: string; enabled?: boolean }>,
) {
  const kbDir = join(workspaceRoot, '.kb');
  await mkdir(kbDir, { recursive: true });
  const lock = {
    schema: 'kb.marketplace/3',
    plugins: Object.fromEntries(
      Object.entries(installed).map(([id, v]) => [
        id,
        {
          link: v.resolvedPath,
          source: 'local',
          enabled: v.enabled ?? true,
        },
      ]),
    ),
  };
  await writeFile(join(kbDir, 'marketplace.lock'), JSON.stringify(lock, null, 2));
}

describe('doctor lock sync', () => {
  let workspaceRoot: string;
  let pluginsRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'doctor-lock-'));
    pluginsRoot = join(workspaceRoot, '.kb', 'plugins');
    await mkdir(pluginsRoot, { recursive: true });
  });

  it('warns when lock file is absent', async () => {
    await makeScaffoldedPlugin(pluginsRoot, 'foo', { withDist: true });

    const { findings } = await scanRoot(pluginsRoot, { workspaceRoot });
    const lockMiss = findings.find(
      (f) => /no .kb\/marketplace\.lock/.test(f.message),
    );
    expect(lockMiss).toBeDefined();
    expect(lockMiss?.severity).toBe('warn');
  });

  it('warns when plugin is scaffolded but its id is missing from existing lock', async () => {
    await makeScaffoldedPlugin(pluginsRoot, 'foo', { withDist: true });
    await writeLock(workspaceRoot, {
      '@kb-labs/unrelated': { resolvedPath: './elsewhere' },
    });

    const { findings } = await scanRoot(pluginsRoot, { workspaceRoot });
    const missing = findings.find(
      (f) => f.package === '@kb-labs/foo' && /not registered/.test(f.message),
    );
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe('warn');
  });

  it('is silent when plugin is properly registered in lock', async () => {
    await makeScaffoldedPlugin(pluginsRoot, 'bar', { withDist: true });
    await writeLock(workspaceRoot, {
      '@kb-labs/bar': {
        resolvedPath: './.kb/plugins/bar',
      },
    });

    const { findings } = await scanRoot(pluginsRoot, { workspaceRoot });
    const lockFindings = findings.filter(
      (f) => f.package === '@kb-labs/bar' && /lock/i.test(f.message),
    );
    // No lock-related errors/warnings.
    expect(lockFindings.filter((f) => f.severity !== 'info')).toEqual([]);
  });

  it('surfaces info when lock entry is disabled', async () => {
    await makeScaffoldedPlugin(pluginsRoot, 'baz', { withDist: true });
    await writeLock(workspaceRoot, {
      '@kb-labs/baz': {
        resolvedPath: './.kb/plugins/baz',
        enabled: false,
      },
    });

    const { findings } = await scanRoot(pluginsRoot, { workspaceRoot });
    const disabled = findings.find(
      (f) => f.package === '@kb-labs/baz' && /disabled/.test(f.message),
    );
    expect(disabled).toBeDefined();
    expect(disabled?.severity).toBe('info');
  });

  it('warns when lock resolvedPath points elsewhere', async () => {
    await makeScaffoldedPlugin(pluginsRoot, 'qux', { withDist: true });
    await writeLock(workspaceRoot, {
      '@kb-labs/qux': {
        resolvedPath: './some/other/place',
      },
    });

    const { findings } = await scanRoot(pluginsRoot, { workspaceRoot });
    const drift = findings.find(
      (f) => f.package === '@kb-labs/qux' && /lock points at/.test(f.message),
    );
    expect(drift).toBeDefined();
    expect(drift?.severity).toBe('warn');
  });

  it('skips lock checks when workspaceRoot is not given', async () => {
    await makeScaffoldedPlugin(pluginsRoot, 'noroot', { withDist: true });
    const { findings } = await scanRoot(pluginsRoot);
    // No lock-related findings at all.
    expect(findings.find((f) => /lock/i.test(f.message))).toBeUndefined();
  });
});
