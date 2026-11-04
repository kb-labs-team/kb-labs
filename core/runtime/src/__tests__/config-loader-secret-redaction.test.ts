import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContextLogger } from '@kb-labs/core-platform';
import { loadPlatformConfig } from '../config-loader.js';
import { writeTestPlatformReceipt } from './platform-version-fixture.js';

describe('loadPlatformConfig process secret registration', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  // case: S-203.3
  it('registers resolved values declared secret by an installed adapter schema for service logs', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'kb-config-secret-redaction-'));
    const platformRoot = path.join(root, 'platform');
    const projectRoot = path.join(root, 'project');
    const adapterRoot = fileURLToPath(new URL('../../../../adapters/openai', import.meta.url));
    const config = path.join(platformRoot, '.kb');
    await mkdir(path.join(platformRoot, 'node_modules', '@kb-labs', 'cli-bin'), { recursive: true });
    writeTestPlatformReceipt(platformRoot);
    await mkdir(config, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(config, 'marketplace.lock'), JSON.stringify({
      schema: 'kb.marketplace/3',
      plugins: {},
      adapters: {
        openai: {
          source: 'platform', version: '2.120.1', integrity: 'sha256-fixture',
          resolvedPath: path.relative(platformRoot, adapterRoot), enabled: true,
        },
      },
    }));
    const secret = 'x46-config-secret-fixture';
    await writeFile(path.join(config, 'kb.config.json'), JSON.stringify({
      platform: {
        adapters: { llm: 'openai' },
        adapterOptions: { llm: { apiKey: '${X46_CONFIG_SECRET}' } },
      },
    }));

    const loaded = await loadPlatformConfig({
      startDir: projectRoot,
      projectScope: 'platform',
      env: { KB_PLATFORM_ROOT: platformRoot, KB_HOME: path.join(root, 'home'), X46_CONFIG_SECRET: secret },
      loadEnvFile: false,
    });
    const records: Array<Record<string, unknown>> = [];
    const logger = createContextLogger({
      trace: () => {}, debug: () => {}, info: () => {}, warn: () => {},
      error: (message, error, fields) => records.push({ message, error, ...fields }),
      fatal: () => {}, child: () => { throw new Error('unexpected child logger'); }, flush: async () => {},
    }, { applicationId: 'gateway', serviceId: 'gateway', instanceId: 'test', layer: 'service' });
    const nested = logger.forOperation('gateway.request').forComponent('handler');
    const thrown = new Error(`provider rejected ${secret}`, { cause: { provider: secret } });
    nested.error('handler failed', thrown);

    expect(loaded.platformConfig.adapterOptions?.llm).toMatchObject({ apiKey: secret });
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).not.toContain(secret);
    expect((records[0]?.error as Error).message).toContain('[REDACTED]');
    expect(((records[0]?.error as Error).cause as { provider: string }).provider).toBe('[REDACTED]');
  });
});
