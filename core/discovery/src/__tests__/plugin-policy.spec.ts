import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isFirstPartyPluginSource, readPluginPolicy } from '../plugin-policy.js';

describe('readPluginPolicy', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {await fs.rm(root, { recursive: true, force: true });}
    root = undefined;
  });

  async function makeRoot(config: string | null): Promise<string> {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-plugin-policy-'));
    if (config !== null) {
      await fs.mkdir(path.join(root, '.kb'), { recursive: true });
      await fs.writeFile(path.join(root, '.kb', 'kb.config.json'), config);
    }
    return root;
  }

  // case: S-203.25
  it('treats an absent optional config as an unset policy', async () => {
    const result = await readPluginPolicy(await makeRoot(null));
    expect(result).toEqual({ kind: 'valid', policy: {} });
  });

  // case: S-203.25
  it('retains the core-config diagnostic for malformed config', async () => {
    const configRoot = await makeRoot('{"plugins":');
    const result = await readPluginPolicy(configRoot);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'JSON_PARSE_FAILED', path: path.join(configRoot, '.kb', 'kb.config.json') }),
      ]));
    }
  });

  // case: S-203.25
  it('retains the core-config diagnostic when the config cannot be read', async () => {
    const configRoot = await makeRoot(null);
    await fs.mkdir(path.join(configRoot, '.kb'), { recursive: true });
    await fs.mkdir(path.join(configRoot, '.kb', 'kb.config.json'));
    const result = await readPluginPolicy(configRoot);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'FILE_READ_FAILED', path: path.join(configRoot, '.kb', 'kb.config.json') }),
      ]));
    }
  });

  // case: S-203.25
  it('rejects wrongly typed allow and block entries instead of dropping them', async () => {
    const result = await readPluginPolicy(await makeRoot(JSON.stringify({ plugins: { allow: ['valid', 3], block: 'blocked' } })));
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('PLUGIN_POLICY_TYPE_INVALID');
      expect(result.diagnostics.filter(diagnostic => diagnostic.level !== 'info').map(diagnostic => diagnostic.detail)).toEqual(expect.arrayContaining([
        { field: '$.plugins.allow[1]' }, { field: '$.plugins.block' },
      ]));
    }
  });
});

describe('plugin policy provenance', () => {
  it('exempts workspace, linked, and platform-shipped packages independently of package names', () => {
    expect(isFirstPartyPluginSource({ origin: 'workspace', scope: 'project', lockSource: undefined })).toBe(true);
    expect(isFirstPartyPluginSource({ origin: 'linked', scope: 'project', lockSource: 'local' })).toBe(true);
    expect(isFirstPartyPluginSource({ origin: 'node_modules', scope: 'platform', lockSource: 'platform' })).toBe(true);
    expect(isFirstPartyPluginSource({ origin: 'node_modules', scope: 'project', lockSource: 'marketplace' })).toBe(false);
    expect(isFirstPartyPluginSource({ origin: 'node_modules', scope: 'platform', lockSource: 'marketplace' })).toBe(false);
  });
});
