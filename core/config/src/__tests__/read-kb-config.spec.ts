import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ErrorEnvelopeError } from '@kb-labs/core-platform/error-envelope';
import { readKbConfig, readRawKbConfig } from '../api/read-kb-config.js';
import { setUserConfigValue } from '../user-config/write-user-config.js';

describe('readKbConfig secret references', () => {
  let root = '';
  let file = '';

  afterEach(async () => {
    if (root) { await fs.rm(root, { recursive: true, force: true }); }
    root = '';
    file = '';
  });

  async function fixture(): Promise<void> {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-read-config-'));
    file = path.join(root, '.kb', 'kb.config.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ marketplace: { sources: [{ kind: 'registry', authToken: '${MARKETPLACE_TOKEN}' }] } }));
  }

  it('resolves references for runtime reads while preserving a raw read API', async () => {
    await fixture();
    const env = { ...process.env, MARKETPLACE_TOKEN: 'secret-value' };

    await expect(readKbConfig(root, { required: true, env })).resolves.toMatchObject({
      data: { marketplace: { sources: [{ authToken: 'secret-value' }] } },
    });
    await expect(readRawKbConfig(root)).resolves.toMatchObject({
      data: { marketplace: { sources: [{ authToken: '${MARKETPLACE_TOKEN}' }] } },
    });
  });

  it('reports a missing required reference through the error catalogue', async () => {
    await fixture();
    await expect(readKbConfig(root, { required: true, env: {} })).rejects.toMatchObject({
      name: 'ErrorEnvelopeError',
      envelope: { code: 'KB_CONFIG_SECRET_MISSING' },
    });
  });

  it('keeps the reference literal on disk during read-modify-write', async () => {
    await fixture();
    const env = { ...process.env, MARKETPLACE_TOKEN: 'secret-value' };
    const raw = await readRawKbConfig(root);
    const source = (raw?.data as { marketplace: { sources: Array<{ authToken: string }> } }).marketplace.sources[0]!;

    await setUserConfigValue({
      filePath: file,
      path: ['marketplace', 'sources', '0', 'authToken'],
      value: source.authToken,
      allowMissingEnv: false,
      env,
    });

    const onDisk = await fs.readFile(file, 'utf8');
    expect(onDisk).toContain('${MARKETPLACE_TOKEN}');
    expect(onDisk).not.toContain('secret-value');
  });
});
