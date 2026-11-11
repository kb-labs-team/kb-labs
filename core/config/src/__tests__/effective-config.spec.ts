import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PlatformConfigError } from '@kb-labs/core-platform';
import { loadEffectiveConfig as resolveEffectiveConfig } from '../api/effective-config';

const TEST_PROJECT_ID = 'prj_effective_test';
function testStoreRoot(projectRoot: string): string {
  return path.join(path.dirname(projectRoot), 'platform-state');
}
function loadEffectiveConfig(projectRoot: string, options: Parameters<typeof resolveEffectiveConfig>[0] = {}) {
  return resolveEffectiveConfig({
    ...options,
    projectId: TEST_PROJECT_ID,
    storeRoot: testStoreRoot(projectRoot),
  });
}

// ─── Filesystem helpers ─────────────────────────────────────────────────

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'kb-effective-config-'));
}

async function writeConfigAt(root: string, filename: string, contents: string) {
  const dir = path.dirname(path.join(root, filename));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(root, filename), contents, 'utf8');
}

async function writeProjectConfig(
  root: string,
  contents: string,
  filename = '.kb/kb.config.json',
) {
  void filename;
  const store = path.join(testStoreRoot(root), 'state', TEST_PROJECT_ID, 'config.jsonc');
  await fsp.mkdir(path.dirname(store), { recursive: true });
  await fsp.writeFile(store, contents, 'utf8');
}

async function writePlatformConfig(
  root: string,
  contents: string,
  filename = '.kb/kb.config.json',
) {
  await writeConfigAt(root, filename, contents);
}

async function writeOverlay(root: string, name: string, contents: string) {
  const dir = path.join(testStoreRoot(root), 'state', TEST_PROJECT_ID, 'overlays');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, name), contents, 'utf8');
}

// Shared tmpdir lifecycle for every describe — each test starts clean.
function makeFixture() {
  const ctx: { tmp: string; project: string; platform: string } = {
    tmp: '',
    project: '',
    platform: '',
  };
  beforeEach(async () => {
    ctx.tmp = await makeTmpDir();
    ctx.project = path.join(ctx.tmp, 'project');
    ctx.platform = path.join(ctx.tmp, 'platform');
  });
  afterEach(async () => {
    await fsp.rm(ctx.tmp, { recursive: true, force: true });
  });
  return ctx;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('loadEffectiveConfig — layer presence matrix', () => {
  const c = makeFixture();

  it('returns null when no layer contributes', async () => {
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res).toBeNull();
  });

  it('platform-only (project missing, no overlays)', async () => {
    await writePlatformConfig(c.platform, '{"gateway":{"port":4000}}');
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res).not.toBeNull();
    expect(res!.data).toEqual({ gateway: { port: 4000 } });
    expect(res!.platformConfigPath).toBe(path.join(c.platform, '.kb', 'kb.config.json'));
    expect(res!.projectConfigPath).toBeUndefined();
    expect(res!.overlayPaths).toEqual([]);
  });

  it('project-only (no platformRoot)', async () => {
    await writeProjectConfig(c.project, '{"gateway":{"port":4000}}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data).toEqual({ gateway: { port: 4000 } });
    expect(res!.platformConfigPath).toBeUndefined();
    expect(res!.projectConfigPath).toBeDefined();
  });

  it('overlays-only (no platform, no project)', async () => {
    await writeOverlay(c.project, 'p.jsonc', '{"gateway":{"port":5000}}');
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res).not.toBeNull();
    expect(res!.data).toEqual({ gateway: { port: 5000 } });
    expect(res!.platformConfigPath).toBeUndefined();
    expect(res!.projectConfigPath).toBeUndefined();
    expect(res!.overlayPaths).toHaveLength(1);
  });

  it('platform + project (project overrides platform)', async () => {
    await writePlatformConfig(c.platform, '{"gateway":{"port":4000,"host":"0.0.0.0"}}');
    await writeProjectConfig(c.project, '{"gateway":{"port":5000}}');
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res!.data).toEqual({ gateway: { port: 5000, host: '0.0.0.0' } });
  });

  it('platform + overlays (no project file)', async () => {
    await writePlatformConfig(c.platform, '{"gateway":{"port":4000}}');
    await writeOverlay(c.project, 'p.jsonc', '{"gateway":{"pressure":{"enabled":true}}}');
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res!.data).toEqual({
      gateway: { port: 4000, pressure: { enabled: true } },
    });
  });

  it('project + overlays (no platformRoot)', async () => {
    await writeProjectConfig(c.project, '{"gateway":{"port":4000}}');
    await writeOverlay(c.project, 'p.jsonc', '{"gateway":{"port":5000}}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data).toEqual({ gateway: { port: 5000 } });
  });

  it('all three layers merged in order', async () => {
    await writePlatformConfig(c.platform, '{"a":1,"b":1,"c":1}');
    await writeProjectConfig(c.project, '{"b":2,"c":2}');
    await writeOverlay(c.project, 'p.jsonc', '{"c":3}');
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res!.data).toEqual({ a: 1, b: 2, c: 3 });
  });
});

describe('loadEffectiveConfig — layer ordering', () => {
  const c = makeFixture();

  it('overlays win over project layer', async () => {
    await writeProjectConfig(c.project, '{"value":"project"}');
    await writeOverlay(c.project, 'p.jsonc', '{"value":"overlay"}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data.value).toBe('overlay');
  });

  it('project wins over platform layer', async () => {
    await writePlatformConfig(c.platform, '{"value":"platform"}');
    await writeProjectConfig(c.project, '{"value":"project"}');
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res!.data.value).toBe('project');
  });

  it('overlays win over platform even without a project layer', async () => {
    await writePlatformConfig(c.platform, '{"value":"platform"}');
    await writeOverlay(c.project, 'p.jsonc', '{"value":"overlay"}');
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res!.data.value).toBe('overlay');
  });

  it('later overlay (by lex order) wins over earlier overlay', async () => {
    await writeProjectConfig(c.project, '{"value":"project"}');
    await writeOverlay(c.project, 'a-first.jsonc', '{"value":"first"}');
    await writeOverlay(c.project, 'z-last.jsonc', '{"value":"last"}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data.value).toBe('last');
  });

  it('overlayPaths reflects lex application order', async () => {
    await writeProjectConfig(c.project, '{}');
    await writeOverlay(c.project, 'b.jsonc', '{}');
    await writeOverlay(c.project, 'a.jsonc', '{}');
    await writeOverlay(c.project, 'c.jsonc', '{}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.overlayPaths.map((p) => path.basename(p))).toEqual([
      'a.jsonc',
      'b.jsonc',
      'c.jsonc',
    ]);
  });

  it('numeric prefixes sort lexically (not numerically)', async () => {
    // Documenting current behaviour: lex order means "10" comes BEFORE "2".
    // If callers want numeric order they have to zero-pad ("02", "10").
    await writeProjectConfig(c.project, '{}');
    await writeOverlay(c.project, '2.jsonc', '{}');
    await writeOverlay(c.project, '10.jsonc', '{}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.overlayPaths.map((p) => path.basename(p))).toEqual([
      '10.jsonc',
      '2.jsonc',
    ]);
  });
});

describe('loadEffectiveConfig — manifest defaults', () => {
  const c = makeFixture();

  it('merges manifest defaults, platform values, project values, and overlays in order with provenance', async () => {
    const manifestPath = path.join(c.platform, 'plugins', 'sample', 'manifest.json');
    const defaults = [{
      layer: 'manifest' as const,
      path: manifestPath,
      data: { plugins: { sample: { enabled: true, scope: { scopes: [{ id: 'default' }] } } } },
    }];
    await writePlatformConfig(c.platform, '{"plugins":{"sample":{"scope":{"scopes":[{"id":"platform"}]}}}}');
    await writeProjectConfig(c.project, '{"plugins":{"sample":{"scope":{"scopes":[{"id":"project"}]}}}}');
    await writeOverlay(c.project, 'override.jsonc', '{"plugins":{"sample":{"scope":{"active":"overlay"}}}}');

    const result = await loadEffectiveConfig(c.project, {
      platformRoot: c.platform,
      projectId: TEST_PROJECT_ID,
      storeRoot: testStoreRoot(c.project),
      pluginDefaults: defaults,
    });

    expect(result?.data.plugins).toEqual({
      sample: { enabled: true, scope: { scopes: [{ id: 'project' }], active: 'overlay' } },
    });
    expect(result?.provenance['plugins.sample.enabled']).toEqual({ layer: 'manifest', source: manifestPath });
    expect(result?.provenance['plugins.sample.scope.scopes']).toEqual({
      layer: 'project',
      source: path.join(testStoreRoot(c.project), 'state', TEST_PROJECT_ID, 'config.jsonc'),
      contributors: [
        { layer: 'project', source: path.join(testStoreRoot(c.project), 'state', TEST_PROJECT_ID, 'config.jsonc') },
        { layer: 'platform', source: path.join(c.platform, '.kb', 'kb.config.json') },
        { layer: 'manifest', source: manifestPath },
      ],
    });
    expect(result?.provenance['plugins.sample.scope.active']?.layer).toBe('overlay');
  });
});

describe('loadEffectiveConfig — deep-merge semantics', () => {
  const c = makeFixture();

  it('nested objects merge recursively', async () => {
    await writeProjectConfig(
      c.project,
      '{"a":{"b":{"c":1,"d":2},"e":3}}',
    );
    await writeOverlay(c.project, 'p.jsonc', '{"a":{"b":{"c":99}}}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data).toEqual({ a: { b: { c: 99, d: 2 }, e: 3 } });
  });

  it('introduced keys are added (no shadowing siblings)', async () => {
    await writeProjectConfig(c.project, '{"existing":1}');
    await writeOverlay(c.project, 'p.jsonc', '{"new":2}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data).toEqual({ existing: 1, new: 2 });
  });

  it('project arrays replace platform arrays', async () => {
    await writePlatformConfig(c.platform, '{"plugins":{"sample":{"sources":["a"]}}}');
    await writeProjectConfig(c.project, '{"plugins":{"sample":{"sources":["b"]}}}');
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect((res!.data.plugins as Record<string, { sources: string[] }>).sample!.sources).toEqual(['b']);
  });

  it('rejects project adapter sections when a platform root is configured', async () => {
    await writePlatformConfig(c.platform, '{"platform":{"adapters":{"llm":"openai"}}}');
    await writeProjectConfig(c.project, '{"platform":{"adapterOptions":{"llm":{"model":"project-model"}}}}');
    await expect(loadEffectiveConfig(c.project, { platformRoot: c.platform }))
      .rejects.toMatchObject({ name: 'AdapterProjectScopeError' });
  });

  it('ignores legacy repository plugin adapter config when a platform root is configured', async () => {
    await writePlatformConfig(c.platform, '{"platform":{"adapters":{"llm":"openai"}}}');
    await writeConfigAt(c.project, '.kb/kb.config.json', '{"plugins":{"sample":{"adapters":{"llm":["openai"]}}}}');
    const result = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(result!.data).toEqual({ platform: { adapters: { llm: 'openai' } } });
  });

  it('overlay arrays REPLACE base arrays by default', async () => {
    await writeProjectConfig(c.project, '{"items":[1,2,3]}');
    await writeOverlay(c.project, 'p.jsonc', '{"items":[4]}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data.items).toEqual([4]);
  });

  it('kb:merge:append concatenates arrays', async () => {
    await writeProjectConfig(c.project, '{"plugins":{"sample":{"features":["base"]}}}');
    await writeOverlay(
      c.project,
      'p.jsonc',
      '{"plugins":{"sample":{"features":["overlay"],"kb:merge":{"features":"append"}}}}',
    );
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data).toEqual({ plugins: { sample: { features: ['base', 'overlay'] } } });
  });

  it('kb:merge directive key is stripped from the result', async () => {
    await writeProjectConfig(c.project, '{"plugins":{"sample":{"adapters":{"llm":["openai"]}}}}');
    await writeOverlay(
      c.project,
      'p.jsonc',
      '{"plugins":{"sample":{"adapters":{"kb:merge":{"llm":"append"},"llm":["x"]}}}}',
    );
    const res = await loadEffectiveConfig(c.project);
    expect((res!.data.plugins as { sample: { adapters: Record<string, unknown> } }).sample.adapters['kb:merge']).toBeUndefined();
  });

  it('multiple overlays each append (cumulative)', async () => {
    await writeProjectConfig(c.project, '{"x":[1]}');
    await writeOverlay(
      c.project,
      'a.jsonc',
      '{"kb:merge":{"x":"append"},"x":[2]}',
    );
    await writeOverlay(
      c.project,
      'b.jsonc',
      '{"kb:merge":{"x":"append"},"x":[3]}',
    );
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data.x).toEqual([1, 2, 3]);
  });

  it('type mismatch: overlay value wins (object → scalar)', async () => {
    await writeProjectConfig(c.project, '{"v":{"nested":true}}');
    await writeOverlay(c.project, 'p.jsonc', '{"v":"plain-string"}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data.v).toBe('plain-string');
  });

  it('type mismatch: overlay value wins (scalar → object)', async () => {
    await writeProjectConfig(c.project, '{"v":42}');
    await writeOverlay(c.project, 'p.jsonc', '{"v":{"now":"object"}}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data.v).toEqual({ now: 'object' });
  });

  it('null in overlay overrides defined value', async () => {
    await writeProjectConfig(c.project, '{"v":"defined"}');
    await writeOverlay(c.project, 'p.jsonc', '{"v":null}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data.v).toBeNull();
  });

  it('empty overlay object is a no-op', async () => {
    await writeProjectConfig(c.project, '{"v":1}');
    await writeOverlay(c.project, 'p.jsonc', '{}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data).toEqual({ v: 1 });
  });
});

describe('loadEffectiveConfig — file format precedence', () => {
  const c = makeFixture();

  // case: S-204.8
  it('does not load any repository kb.config file as project settings', async () => {
    await writeConfigAt(c.project, '.kb/kb.config.json', '{"plugins":{"commit":{"legacy":true}}}');
    await writeConfigAt(c.project, 'kb.config.jsonc', '{"plugins":{"commit":{"rootLegacy":true}}}');
    const res = await loadEffectiveConfig(c.project);
    expect(res).toBeNull();
    expect(await fsp.readFile(path.join(c.project, '.kb/kb.config.json'), 'utf8'))
      .toBe('{"plugins":{"commit":{"legacy":true}}}');
  });

  it('parses JSONC in the platform-owned project settings document', async () => {
    await writeProjectConfig(
      c.project,
      `{
        // line comment
        "gateway": {
          "port": 4000, /* inline */
        },
      }`,
    );
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data).toEqual({ gateway: { port: 4000 } });
    expect(res!.diagnostics).toEqual([]);
  });

  it('parses JSONC overlays with comments', async () => {
    await writeProjectConfig(c.project, '{}');
    await writeOverlay(
      c.project,
      'p.jsonc',
      `{
        // pressure overlay
        "gateway": { "pressure": { "enabled": true } } // <- trailing
      }`,
    );
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data).toEqual({ gateway: { pressure: { enabled: true } } });
  });
});

describe('loadEffectiveConfig — diagnostics', () => {
  const c = makeFixture();

  it('rejects a malformed platform-owned project settings document', async () => {
    await writeProjectConfig(c.project, '{ not json');
    await expect(loadEffectiveConfig(c.project)).rejects.toMatchObject({
      name: 'PlatformConfigError', reason: 'parse',
      configPath: path.join(testStoreRoot(c.project), 'state', TEST_PROJECT_ID, 'config.jsonc'),
    });
  });

  it('maps unreadable project settings and overlays to typed read errors', async () => {
    const settingsPath = path.join(testStoreRoot(c.project), 'state', TEST_PROJECT_ID, 'config.jsonc');
    await fsp.mkdir(settingsPath, { recursive: true });
    await expect(loadEffectiveConfig(c.project)).rejects.toMatchObject({
      name: 'PlatformConfigError', reason: 'read', configPath: settingsPath,
    });

    await fsp.rm(settingsPath, { recursive: true });
    await writeProjectConfig(c.project, '{}');
    const overlayPath = path.join(testStoreRoot(c.project), 'state', TEST_PROJECT_ID, 'overlays', 'unreadable.jsonc');
    await fsp.mkdir(overlayPath, { recursive: true });
    await expect(loadEffectiveConfig(c.project)).rejects.toMatchObject({
      name: 'PlatformConfigError', reason: 'read', configPath: overlayPath,
    });
  });

  // case: S-204.8
  it('ignores a non-object legacy repository config file', async () => {
    await writeConfigAt(c.project, '.kb/kb.config.json', '[1,2,3]');
    expect(await loadEffectiveConfig(c.project)).toBeNull();
  });

  it('rejects CONFIG_NOT_OBJECT when platform top-level is an array', async () => {
    await writePlatformConfig(c.platform, '[1,2,3]');
    await expect(loadEffectiveConfig(c.project, { platformRoot: c.platform })).rejects.toMatchObject({
      name: 'PlatformConfigError', reason: 'invalid',
    });
  });

  it('rejects OVERLAY_NOT_OBJECT for non-object overlay', async () => {
    await writeProjectConfig(c.project, '{}');
    await writeOverlay(c.project, 'bad.jsonc', '[1,2,3]');
    await expect(loadEffectiveConfig(c.project)).rejects.toMatchObject({
      name: 'PlatformConfigError', reason: 'invalid',
    });
  });

  it('rejects a malformed overlay instead of applying a partial config', async () => {
    await writeProjectConfig(c.project, '{"v":0}');
    await writeOverlay(c.project, 'a.jsonc', '{"v":1}');
    await writeOverlay(c.project, 'b.jsonc', '{ broken');
    await writeOverlay(c.project, 'c.jsonc', '{"v":3}');
    await expect(loadEffectiveConfig(c.project)).rejects.toMatchObject({
      name: 'PlatformConfigError', reason: 'parse',
    });
  });

  it('emits no diagnostics on the happy path', async () => {
    await writePlatformConfig(c.platform, '{"a":1}');
    await writeProjectConfig(c.project, '{"b":2}');
    await writeOverlay(c.project, 'p.jsonc', '{"c":3}');
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res!.diagnostics).toEqual([]);
  });

  it('rejects the first invalid layer when multiple layers contain errors', async () => {
    await writePlatformConfig(c.platform, '{ bad platform');
    await writeOverlay(c.project, 'bad.jsonc', '{ broken');
    await expect(loadEffectiveConfig(c.project, { platformRoot: c.platform })).rejects.toBeInstanceOf(PlatformConfigError);
  });

  it('rejects an empty overlay file as invalid JSON', async () => {
    await writeProjectConfig(c.project, '{}');
    await writeOverlay(c.project, 'empty.jsonc', '');
    await expect(loadEffectiveConfig(c.project)).rejects.toMatchObject({
      name: 'PlatformConfigError', reason: 'parse',
    });
  });
});

describe('loadEffectiveConfig — path resolution & result fields', () => {
  const c = makeFixture();

  it('returns absolute paths in all path fields', async () => {
    await writePlatformConfig(c.platform, '{}');
    await writeProjectConfig(c.project, '{}');
    await writeOverlay(c.project, 'p.jsonc', '{}');
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(path.isAbsolute(res!.platformConfigPath!)).toBe(true);
    expect(path.isAbsolute(res!.projectConfigPath!)).toBe(true);
    expect(res!.projectConfigPath).toBe(path.join(testStoreRoot(c.project), 'state', TEST_PROJECT_ID, 'config.jsonc'));
    expect(res!.overlayPaths.every((p) => path.isAbsolute(p))).toBe(true);
  });

  it('ignores platformRoot when it equals projectRoot (no double-merge)', async () => {
    await writeProjectConfig(c.project, '{"v":1}');
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.project });
    expect(res!.data).toEqual({ v: 1 });
    expect(res!.platformConfigPath).toBeUndefined();
  });

  it('treats undefined platformRoot as no platform layer', async () => {
    await writePlatformConfig(c.platform, '{"v":"platform"}');
    await writeProjectConfig(c.project, '{}');
    const res = await loadEffectiveConfig(c.project); // no opts
    expect(res!.data).toEqual({});
    expect(res!.platformConfigPath).toBeUndefined();
  });

  it('platformConfigPath unset when platform root has no kb.config.*', async () => {
    await writeProjectConfig(c.project, '{}');
    // platform dir exists but is empty
    await fsp.mkdir(c.platform, { recursive: true });
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res!.platformConfigPath).toBeUndefined();
  });

  it('projectConfigPath unset when project has only overlays', async () => {
    await writeOverlay(c.project, 'p.jsonc', '{}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.projectConfigPath).toBeUndefined();
    expect(res!.overlayPaths).toHaveLength(1);
  });

  it('result is null only when literally nothing exists', async () => {
    // Neither dir created.
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res).toBeNull();
  });
});

describe('loadEffectiveConfig — overlay isolation', () => {
  const c = makeFixture();

  it('repository and platform overlays are NOT loaded', async () => {
    await writePlatformConfig(c.platform, '{"v":"platform"}');
    // Project overlays now live in platform-owned state; old repository and
    // platform-root locations are both ignored.
    await fsp.mkdir(path.join(c.platform, '.kb', 'overlays'), { recursive: true });
    await fsp.writeFile(
      path.join(c.platform, '.kb', 'overlays', 'rogue.jsonc'),
      '{"v":"rogue"}',
    );
    await fsp.mkdir(path.join(c.project, '.kb', 'overlays'), { recursive: true });
    await fsp.writeFile(path.join(c.project, '.kb', 'overlays', 'legacy.jsonc'), '{"v":"legacy"}');
    await writeProjectConfig(c.project, '{}');
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res!.data.v).toBe('platform');
    expect(res!.overlayPaths).toEqual([]);
  });

  it('non-.jsonc files in the project store overlays directory are ignored', async () => {
    await writeProjectConfig(c.project, '{"v":"project"}');
    const overlayDir = path.join(testStoreRoot(c.project), 'state', TEST_PROJECT_ID, 'overlays');
    await fsp.mkdir(overlayDir, { recursive: true });
    await fsp.writeFile(path.join(overlayDir, 'README.md'), '# docs');
    await fsp.writeFile(path.join(overlayDir, 'skip.json'), '{"v":"json"}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data.v).toBe('project');
    expect(res!.overlayPaths).toEqual([]);
  });

  it('overlays in subdirectories of the project store are NOT loaded', async () => {
    await writeProjectConfig(c.project, '{"v":"project"}');
    const nested = path.join(testStoreRoot(c.project), 'state', TEST_PROJECT_ID, 'overlays', 'nested');
    await fsp.mkdir(nested, { recursive: true });
    await fsp.writeFile(path.join(nested, 'a.jsonc'), '{"v":"nested"}');
    const res = await loadEffectiveConfig(c.project);
    expect(res!.data.v).toBe('project');
    expect(res!.overlayPaths).toEqual([]);
  });
});

describe('loadEffectiveConfig — realistic scenarios', () => {
  const c = makeFixture();

  it('gateway pressure: overlay adds pressure section to full platform baseline', async () => {
    // Mimics the CI shape: platform has full gateway block; project layer
    // has nothing gateway-related; scenario overlay only carries the
    // pressure delta. Result must include both.
    await writePlatformConfig(
      c.platform,
      JSON.stringify({
        gateway: {
          port: 4000,
          upstreams: { rest: { url: 'http://rest:5050' } },
          staticTokens: { 'dev-token': { hostId: 'studio', namespaceId: 'default' } },
        },
      }),
    );
    await writeProjectConfig(c.project, '{"platform":{"dir":"/root/kb-platform"}}');
    await writeOverlay(
      c.project,
      'gateway-pressure__overlay.jsonc',
      JSON.stringify({
        gateway: {
          pressure: {
            enabled: true,
            perService: { rest: { requestsPerSecond: 5 } },
          },
        },
      }),
    );

    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res!.data).toEqual({
      platform: { dir: '/root/kb-platform' },
      gateway: {
        port: 4000,
        upstreams: { rest: { url: 'http://rest:5050' } },
        staticTokens: { 'dev-token': { hostId: 'studio', namespaceId: 'default' } },
        pressure: {
          enabled: true,
          perService: { rest: { requestsPerSecond: 5 } },
        },
      },
    });
  });

  it('overlay disables a baseline-enabled feature', async () => {
    await writePlatformConfig(c.platform, '{"feature":{"enabled":true,"opts":{"x":1}}}');
    await writeProjectConfig(c.project, '{}');
    await writeOverlay(c.project, 'kill.jsonc', '{"feature":{"enabled":false}}');
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res!.data).toEqual({
      feature: { enabled: false, opts: { x: 1 } }, // opts preserved from baseline
    });
  });

  it('overlay extends a feature list via kb:merge:append', async () => {
    await writePlatformConfig(
      c.platform,
      '{"feature":{"providers":["platform-provider"]}}',
    );
    await writeProjectConfig(c.project, '{}');
    await writeOverlay(
      c.project,
      'feature-providers.jsonc',
      `{"feature":{"kb:merge":{"providers":"append"},"providers":["project-provider"]}}`,
    );
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect((res!.data.feature as { providers: string[] }).providers).toEqual([
      'platform-provider',
      'project-provider',
    ]);
  });

  it('two overlays cooperate (one tweaks baseline, another adds new field)', async () => {
    await writePlatformConfig(c.platform, '{"a":1,"b":2}');
    await writeProjectConfig(c.project, '{}');
    await writeOverlay(c.project, 'a__bump.jsonc', '{"a":10}');
    await writeOverlay(c.project, 'b__add.jsonc', '{"c":3}');
    const res = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(res!.data).toEqual({ a: 10, b: 2, c: 3 });
  });
});

describe('loadEffectiveConfig — idempotency & side effects', () => {
  const c = makeFixture();

  it('two consecutive loads return equal data without mutating disk', async () => {
    await writePlatformConfig(c.platform, '{"v":1}');
    await writeProjectConfig(c.project, '{"v":2}');
    await writeOverlay(c.project, 'p.jsonc', '{"v":3}');

    const first = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    const second = await loadEffectiveConfig(c.project, { platformRoot: c.platform });
    expect(first!.data).toEqual(second!.data);
    expect(first!.overlayPaths).toEqual(second!.overlayPaths);
  });

  it('mutating the returned data does not affect subsequent calls', async () => {
    await writeProjectConfig(c.project, '{"nested":{"v":1}}');
    const first = await loadEffectiveConfig(c.project);
    (first!.data.nested as { v: number }).v = 999;
    const second = await loadEffectiveConfig(c.project);
    expect((second!.data.nested as { v: number }).v).toBe(1);
  });
});
