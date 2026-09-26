import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadEffectiveConfig } from '../api/effective-config.js';
import { buildProvenance, loadGeneratedLayer, resolveUserConfigFile } from '../user-config/layers.js';
import { setUserConfigValue } from '../user-config/write-user-config.js';

let tmp: string;
let platform: string;
let project: string;

async function write(root: string, rel: string, contents: string): Promise<string> {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, contents, 'utf8');
  return full;
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-config-layers-'));
  platform = path.join(tmp, 'platform');
  project = path.join(tmp, 'project');
  await fsp.mkdir(platform, { recursive: true });
  await fsp.mkdir(project, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('layer precedence: generated < platform user < project user < overlay', () => {
  beforeEach(async () => {
    await write(
      platform,
      '.kb/generated/topology.jsonc',
      `{ // written by the installer
        "gateway": { "port": 4000, "host": "127.0.0.1" },
        "platform": { "adapterOptions": { "llm": { "model": "generated-model", "baseURL": "http://gen" } } }
      }`,
    );
    await write(
      platform,
      '.kb/kb.config.jsonc',
      `{ "platform": { "adapterOptions": { "llm": { "model": "platform-model", "temperature": 0.2 } } },
         "gateway": { "host": "0.0.0.0" } }`,
    );
    await write(
      project,
      '.kb/kb.config.jsonc',
      `{ "platform": { "adapterOptions": { "llm": { "temperature": 0.9 } } } }`,
    );
  });

  it('project user config wins over platform user config, which wins over generated', async () => {
    const result = await loadEffectiveConfig(project, { platformRoot: platform });
    expect(result?.data).toEqual({
      gateway: { port: 4000, host: '0.0.0.0' },
      platform: { adapterOptions: { llm: { model: 'platform-model', baseURL: 'http://gen', temperature: 0.9 } } },
    });
  });

  it('reports which layer and file supplied every value', async () => {
    const result = await loadEffectiveConfig(project, { platformRoot: platform });
    const p = result!.provenance;
    const generatedFile = path.join(platform, '.kb/generated/topology.jsonc');
    const platformFile = path.join(platform, '.kb/kb.config.jsonc');
    const projectFile = path.join(project, '.kb/kb.config.jsonc');

    expect(p['gateway.port']).toEqual({ layer: 'generated', source: generatedFile });
    expect(p['gateway.host']).toEqual({ layer: 'platform', source: platformFile });
    expect(p['platform.adapterOptions.llm.baseURL']).toEqual({ layer: 'generated', source: generatedFile });
    expect(p['platform.adapterOptions.llm.model']).toEqual({ layer: 'platform', source: platformFile });
    expect(p['platform.adapterOptions.llm.temperature']).toEqual({ layer: 'project', source: projectFile });
    expect(result!.generatedConfigPaths).toEqual([generatedFile]);
    expect(result!.layers.map((l) => l.layer)).toEqual(['generated', 'platform', 'project']);
  });

  it('attributes overlay values to the overlay layer', async () => {
    const overlay = await write(project, '.kb/overlays/x.jsonc', '{ "gateway": { "port": 4100 } }');
    const result = await loadEffectiveConfig(project, { platformRoot: platform });
    expect((result!.data.gateway as { port: number }).port).toBe(4100);
    expect(result!.provenance['gateway.port']).toEqual({ layer: 'overlay', source: overlay });
  });

  it('applies the project root generated files after the platform root generated files', async () => {
    await write(project, '.kb/generated/local.json', '{ "gateway": { "port": 4200, "extra": true } }');
    const result = await loadEffectiveConfig(project, { platformRoot: platform });
    // Both generated layers are still below the user layers.
    expect(result!.provenance['gateway.port']).toMatchObject({ layer: 'generated', source: path.join(project, '.kb/generated/local.json') });
    expect(result!.provenance['gateway.extra']?.layer).toBe('generated');
    expect(result!.provenance['gateway.host']?.layer).toBe('platform');
    expect(result!.generatedConfigPaths).toEqual([
      path.join(platform, '.kb/generated/topology.jsonc'),
      path.join(project, '.kb/generated/local.json'),
    ]);
  });

  it('a user value replacing a generated object wipes the stale generated leaves from provenance', async () => {
    await write(project, '.kb/kb.config.jsonc', '{ "gateway": "disabled" }');
    const result = await loadEffectiveConfig(project, { platformRoot: platform });
    expect(result!.data.gateway).toBe('disabled');
    expect(result!.provenance.gateway?.layer).toBe('project');
    expect(Object.keys(result!.provenance).some((key) => key.startsWith('gateway.'))).toBe(false);
  });
});

describe('the generated layer is optional', () => {
  it('works unchanged when there is no .kb/generated directory', async () => {
    await write(project, '.kb/kb.config.json', '{ "a": 1 }');
    const result = await loadEffectiveConfig(project);
    expect(result?.data).toEqual({ a: 1 });
    expect(result?.generatedConfigPaths).toEqual([]);
    expect(result?.provenance).toEqual({ a: { layer: 'project', source: path.join(project, '.kb/kb.config.json') } });
  });

  it('a generated layer alone is enough to produce a config', async () => {
    await write(project, '.kb/generated/g.json', '{ "gateway": { "port": 1 } }');
    const result = await loadEffectiveConfig(project);
    expect(result?.data).toEqual({ gateway: { port: 1 } });
  });

  it('skips unreadable generated files with a diagnostic and ignores non-json files', async () => {
    await write(project, '.kb/generated/broken.json', '{ nope');
    await write(project, '.kb/generated/README.md', '# not config');
    await write(project, '.kb/generated/list.json', '[1]');
    const generated = await loadGeneratedLayer([project]);
    expect(generated.files).toEqual([]);
    expect(generated.diagnostics.map((d) => d.code).sort()).toEqual(['CONFIG_NOT_OBJECT', 'JSON_PARSE_FAILED']);
  });

  it('applies generated files in lexicographic order, later files winning', async () => {
    await write(project, '.kb/generated/10-a.json', '{ "k": "a", "only-a": 1 }');
    await write(project, '.kb/generated/20-b.json', '{ "k": "b" }');
    const generated = await loadGeneratedLayer([project, project]);
    expect(generated.data).toEqual({ k: 'b', 'only-a': 1 });
    expect(generated.files).toHaveLength(2);
  });
});

describe('array provenance', () => {
  it('lists every contributing layer for arrays, which concatenate', async () => {
    await write(platform, '.kb/generated/g.json', '{ "plugins": { "allow": ["a"] } }');
    await write(platform, '.kb/kb.config.jsonc', '{ "plugins": { "allow": ["b"] } }');
    await write(project, '.kb/kb.config.jsonc', '{ "plugins": { "allow": ["c"] } }');
    const result = await loadEffectiveConfig(project, { platformRoot: platform });
    expect((result!.data.plugins as { allow: string[] }).allow).toEqual(['a', 'b', 'c']);
    const entry = result!.provenance['plugins.allow']!;
    expect(entry.layer).toBe('project');
    expect(entry.contributors?.map((c) => c.layer)).toEqual(['project', 'platform', 'generated']);
  });

  it('stops at an overlay because overlays replace arrays', () => {
    const provenance = buildProvenance(
      [
        { layer: 'platform', path: '/p', data: { x: [1] } },
        { layer: 'overlay', path: '/o', data: { x: [2] } },
      ],
      { x: [2] },
    );
    expect(provenance.x).toEqual({ layer: 'overlay', source: '/o' });
  });
});

describe('one writer per file: config set never touches generated files', () => {
  it('writes the user config; the generated layer is untouched and still below it', async () => {
    const generatedFile = await write(platform, '.kb/generated/topology.json', '{ "gateway": { "port": 4000 } }');
    const before = await fsp.readFile(generatedFile, 'utf8');

    const userFile = await resolveUserConfigFile(project);
    expect(userFile).toBe(path.join(project, '.kb', 'kb.config.jsonc'));
    await setUserConfigValue({ filePath: userFile, path: ['gateway', 'port'], value: 4300 });

    expect(await fsp.readFile(generatedFile, 'utf8')).toBe(before);
    const result = await loadEffectiveConfig(project, { platformRoot: platform });
    expect(result!.provenance['gateway.port']).toEqual({ layer: 'project', source: userFile });
    expect((result!.data.gateway as { port: number }).port).toBe(4300);
  });

  it('resolveUserConfigFile prefers an existing file over creating .jsonc', async () => {
    await write(project, '.kb/kb.config.json', '{}');
    expect(await resolveUserConfigFile(project)).toBe(path.join(project, '.kb', 'kb.config.json'));
  });
});
