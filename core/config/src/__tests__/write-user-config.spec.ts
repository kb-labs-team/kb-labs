import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { withFileLock, FileLockTimeoutError } from '../user-config/file-lock.js';
import { editDistance, resolveKeyPath, suggestKey } from '../user-config/schema-keys.js';
import { findPlainSecrets, isSecretKeyPath, looksLikeSecretValue } from '../user-config/secrets.js';
import {
  ConfigWriteError,
  revisionOf,
  setUserConfigValue,
  type ConfigWriteErrorCode,
} from '../user-config/write-user-config.js';

const AdapterValue = z.union([z.string().min(1), z.array(z.string().min(1)), z.null()]);

const TEST_SCHEMA = z
  .object({
    platform: z
      .object({
        adapters: z
          .object({ llm: AdapterValue.optional(), cache: AdapterValue.optional() })
          .catchall(AdapterValue)
          .optional(),
        adapterOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
        execution: z
          .object({ mode: z.enum(['auto', 'worker-pool', 'in-process']).optional() })
          .strict()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const DOC = `{
  // hand-written notes must survive
  "platform": {
    "adapters": {
      "llm": "@kb-labs/adapters-openai" // primary
    },
    "execution": { "mode": "worker-pool" }
  }
}
`;

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-config-write-'));
  file = path.join(dir, '.kb', 'kb.config.jsonc');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, DOC, { mode: 0o600 });
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

async function expectCode(promise: Promise<unknown>, code: ConfigWriteErrorCode): Promise<ConfigWriteError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigWriteError);
    expect((error as ConfigWriteError).code).toBe(code);
    return error as ConfigWriteError;
  }
  throw new Error(`expected ${code} but the call succeeded`);
}

describe('setUserConfigValue: comment-preserving atomic write', () => {
  it('writes the value and keeps comments, layout and file mode', async () => {
    const result = await setUserConfigValue({
      filePath: file,
      path: ['platform', 'adapters', 'llm'],
      value: '@kb-labs/adapters-vibeproxy',
      schema: TEST_SCHEMA,
    });

    expect(result.changed).toBe(true);
    expect(result.previousValue).toBe('@kb-labs/adapters-openai');
    const written = await fsp.readFile(file, 'utf8');
    expect(written).toBe(DOC.replace('@kb-labs/adapters-openai', '@kb-labs/adapters-vibeproxy'));
    expect(written).toContain('// hand-written notes must survive');
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    expect(result.revisionAfter).toBe(revisionOf(written));
    // No temp or lock file is left behind.
    expect(await fsp.readdir(path.dirname(file))).toEqual(['kb.config.jsonc']);
  });

  it('creates the file (and directory) when missing', async () => {
    const fresh = path.join(dir, 'project', '.kb', 'kb.config.jsonc');
    const result = await setUserConfigValue({
      filePath: fresh,
      path: ['platform', 'adapters', 'cache'],
      value: '@kb-labs/adapters-redis',
      schema: TEST_SCHEMA,
    });
    expect(result.created).toBe(true);
    expect(JSON.parse(await fsp.readFile(fresh, 'utf8'))).toEqual({
      platform: { adapters: { cache: '@kb-labs/adapters-redis' } },
    });
  });

  it('is a no-op (no write) when the value is already stored', async () => {
    const before = await fsp.stat(file);
    const result = await setUserConfigValue({
      filePath: file,
      path: ['platform', 'adapters', 'llm'],
      value: '@kb-labs/adapters-openai',
      schema: TEST_SCHEMA,
    });
    expect(result.changed).toBe(false);
    expect((await fsp.stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it('dry-run reports the outcome without touching the file', async () => {
    const result = await setUserConfigValue({
      filePath: file,
      path: ['platform', 'adapters', 'cache'],
      value: null,
      schema: TEST_SCHEMA,
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.text).toContain('"cache": null');
    expect(await fsp.readFile(file, 'utf8')).toBe(DOC);
    expect(await fsp.readdir(path.dirname(file))).toEqual(['kb.config.jsonc']);
  });

  it('follows a symlinked config file instead of replacing the link', async () => {
    const target = path.join(dir, 'real.jsonc');
    await fsp.writeFile(target, DOC);
    const link = path.join(dir, 'link.jsonc');
    await fsp.symlink(target, link);
    await setUserConfigValue({ filePath: link, path: ['platform', 'adapters', 'cache'], value: null, schema: TEST_SCHEMA });
    expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fsp.readFile(target, 'utf8')).toContain('"cache": null');
  });
});

describe('setUserConfigValue: concurrency', () => {
  it('serialises concurrent sets of different keys: every write lands, none is lost', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `slot${i}`);
    await Promise.all(
      names.map((name) =>
        setUserConfigValue({
          filePath: file,
          path: ['platform', 'adapters', name],
          value: `@kb-labs/adapters-${name}`,
          schema: TEST_SCHEMA,
        }),
      ),
    );
    const written = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(written.replace(/\/\/.*$/gm, '')) as { platform: { adapters: Record<string, string> } };
    for (const name of names) {
      expect(parsed.platform.adapters[name]).toBe(`@kb-labs/adapters-${name}`);
    }
    expect(written).toContain('// hand-written notes must survive');
    expect(await fsp.readdir(path.dirname(file))).toEqual(['kb.config.jsonc']);
  });

  it('reports KB_CONFIG_CONFLICT when the caller expected a different revision', async () => {
    const stale = revisionOf(DOC);
    await setUserConfigValue({ filePath: file, path: ['platform', 'adapters', 'cache'], value: null, schema: TEST_SCHEMA });
    const error = await expectCode(
      setUserConfigValue({
        filePath: file,
        path: ['platform', 'adapters', 'llm'],
        value: '@kb-labs/adapters-x',
        schema: TEST_SCHEMA,
        expectedRevision: stale,
      }),
      'KB_CONFIG_CONFLICT',
    );
    expect(error.details.path).toContain('kb.config.jsonc');
    // The conflicting write did not happen.
    expect(await fsp.readFile(file, 'utf8')).toContain('@kb-labs/adapters-openai');
  });

  it('reports KB_CONFIG_CONFLICT when an unlocked writer changes the file mid-edit', async () => {
    let edited = false;
    const result = setUserConfigValue({
      filePath: file,
      path: ['platform', 'adapters', 'cache'],
      value: null,
      schema: TEST_SCHEMA,
      // The validate hook runs after the read and before the final re-check.
      validate: async () => {
        if (!edited) {
          edited = true;
          await fsp.appendFile(file, '// external edit\n');
        }
        return [];
      },
    });
    await expectCode(result, 'KB_CONFIG_CONFLICT');
    expect(await fsp.readFile(file, 'utf8')).toBe(`${DOC}// external edit\n`);
  });

  it('reports KB_CONFIG_CONFLICT when the lock cannot be acquired in time', async () => {
    await withFileLock(file, async () => {
      await expectCode(
        setUserConfigValue({
          filePath: file,
          path: ['platform', 'adapters', 'cache'],
          value: null,
          schema: TEST_SCHEMA,
          lock: { timeoutMs: 60, retryDelayMs: 10 },
        }),
        'KB_CONFIG_CONFLICT',
      );
    });
  });
});

describe('setUserConfigValue: schema validation', () => {
  it('rejects a value of the wrong type and names the field path', async () => {
    const error = await expectCode(
      setUserConfigValue({ filePath: file, path: ['platform', 'adapters', 'llm'], value: 42, schema: TEST_SCHEMA }),
      'KB_CONFIG_INVALID',
    );
    expect(error.details.path).toBe('platform.adapters.llm');
    expect(await fsp.readFile(file, 'utf8')).toBe(DOC);
  });

  it('rejects an out-of-enum value', async () => {
    const error = await expectCode(
      setUserConfigValue({ filePath: file, path: ['platform', 'execution', 'mode'], value: 'turbo', schema: TEST_SCHEMA }),
      'KB_CONFIG_INVALID',
    );
    expect(error.details.path).toBe('platform.execution.mode');
  });

  it('rejects an unknown key with a "did you mean" suggestion', async () => {
    const error = await expectCode(
      setUserConfigValue({ filePath: file, path: ['platform', 'adaptors', 'llm'], value: 'x', schema: TEST_SCHEMA }),
      'KB_CONFIG_UNKNOWN_KEY',
    );
    expect(error.details.suggestion).toBe('adapters');
    expect(error.details.path).toBe('platform.adaptors.llm');
  });

  it('rejects a key outside a strict object', async () => {
    const error = await expectCode(
      setUserConfigValue({ filePath: file, path: ['platform', 'execution', 'moed'], value: 'auto', schema: TEST_SCHEMA }),
      'KB_CONFIG_UNKNOWN_KEY',
    );
    expect(error.details.suggestion).toBe('mode');
  });

  it('accepts custom keys in open sections (product sections, custom adapter slots)', async () => {
    await setUserConfigValue({ filePath: file, path: ['plugins', 'commit', 'enabled'], value: true, schema: TEST_SCHEMA });
    await setUserConfigValue({
      filePath: file,
      path: ['platform', 'adapters', 'serviceTransport'],
      value: '@kb-labs/adapters-service-transport-http',
      schema: TEST_SCHEMA,
    });
    const parsed = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/\/\/.*$/gm, '')) as Record<string, unknown>;
    expect(parsed.plugins).toEqual({ commit: { enabled: true } });
  });

  it('still allows editing a file that already has an unrelated schema issue', async () => {
    await fsp.writeFile(file, DOC.replace('"worker-pool"', '"warp"'));
    await setUserConfigValue({ filePath: file, path: ['platform', 'adapters', 'cache'], value: null, schema: TEST_SCHEMA });
    expect(await fsp.readFile(file, 'utf8')).toContain('"cache": null');
  });

  it('runs the extra validate hook on the new document', async () => {
    const error = await expectCode(
      setUserConfigValue({
        filePath: file,
        path: ['platform', 'adapterOptions', 'llm', 'temperature'],
        value: 'hot',
        schema: TEST_SCHEMA,
        validate: (doc) => {
          const options = (doc.platform as { adapterOptions?: { llm?: { temperature?: unknown } } } | undefined)
            ?.adapterOptions?.llm;
          return options && typeof options.temperature !== 'number'
            ? [{ path: 'platform.adapterOptions.llm.temperature', message: 'Expected number' }]
            : [];
        },
      }),
      'KB_CONFIG_INVALID',
    );
    expect(error.message).toContain('Expected number');
  });

  it('rejects a broken file and a path through a scalar instead of guessing', async () => {
    await fsp.writeFile(file, '{ "platform": ');
    await expectCode(
      setUserConfigValue({ filePath: file, path: ['platform', 'adapters', 'llm'], value: 'x', schema: TEST_SCHEMA }),
      'KB_CONFIG_INVALID',
    );

    await fsp.writeFile(file, '{ "platform": "/opt/kb" }');
    const error = await expectCode(
      setUserConfigValue({ filePath: file, path: ['platform', 'adapters', 'llm'], value: 'x' }),
      'KB_CONFIG_INVALID',
    );
    expect(error.details.path).toBe('platform');
  });
});

describe('setUserConfigValue: secrets', () => {
  it('refuses a raw value for a secret key and never echoes it', async () => {
    const error = await expectCode(
      setUserConfigValue({
        filePath: file,
        path: ['platform', 'adapterOptions', 'llm', 'apiKey'],
        value: 'my-very-private-value',
        schema: TEST_SCHEMA,
      }),
      'KB_CONFIG_SECRET_PLAINTEXT',
    );
    expect(JSON.stringify(error.details)).not.toContain('my-very-private-value');
    expect(error.message).not.toContain('my-very-private-value');
    expect(await fsp.readFile(file, 'utf8')).toBe(DOC);
  });

  it('refuses a credential-shaped value even under an innocuous key', async () => {
    await expectCode(
      setUserConfigValue({
        filePath: file,
        path: ['platform', 'adapterOptions', 'llm', 'model'],
        value: 'sk-abcdefghijklmnopqrstuvwxyz012345',
        schema: TEST_SCHEMA,
      }),
      'KB_CONFIG_SECRET_PLAINTEXT',
    );
  });

  it('refuses a plain secret nested inside an object value', async () => {
    await expectCode(
      setUserConfigValue({
        filePath: file,
        path: ['platform', 'adapterOptions', 'notifier'],
        value: { channels: { ops: { type: 'telegram', botToken: 'plain' } } },
        schema: TEST_SCHEMA,
      }),
      'KB_CONFIG_SECRET_PLAINTEXT',
    );
  });

  it('stores a ${ENV_VAR} reference when the variable is set', async () => {
    await setUserConfigValue({
      filePath: file,
      path: ['platform', 'adapterOptions', 'llm', 'apiKey'],
      value: '${OPENAI_API_KEY}',
      schema: TEST_SCHEMA,
      env: { OPENAI_API_KEY: 'present' },
    });
    expect(await fsp.readFile(file, 'utf8')).toContain('"apiKey": "${OPENAI_API_KEY}"');
  });

  it('reports KB_CONFIG_SECRET_MISSING for a reference to an unset variable', async () => {
    const error = await expectCode(
      setUserConfigValue({
        filePath: file,
        path: ['platform', 'adapterOptions', 'llm', 'apiKey'],
        value: '${OPENAI_API_KEY}',
        schema: TEST_SCHEMA,
        env: {},
      }),
      'KB_CONFIG_SECRET_MISSING',
    );
    expect(error.details.variable).toBe('OPENAI_API_KEY');
  });

  it('accepts an unset reference with allowMissingEnv', async () => {
    const result = await setUserConfigValue({
      filePath: file,
      path: ['platform', 'adapterOptions', 'llm', 'apiKey'],
      value: '${OPENAI_API_KEY}',
      schema: TEST_SCHEMA,
      env: {},
      allowMissingEnv: true,
    });
    expect(result.changed).toBe(true);
  });

  it('writes a raw secret only with allowPlainSecret', async () => {
    await setUserConfigValue({
      filePath: file,
      path: ['platform', 'adapterOptions', 'llm', 'apiKey'],
      value: 'throwaway-local-value',
      schema: TEST_SCHEMA,
      allowPlainSecret: true,
    });
    expect(await fsp.readFile(file, 'utf8')).toContain('"apiKey": "throwaway-local-value"');
  });
});

describe('secret helpers', () => {
  it('classifies secret key paths', () => {
    expect(isSecretKeyPath(['adapterOptions', 'llm', 'apiKey'])).toBe(true);
    expect(isSecretKeyPath(['gateway', 'auth', 'jwtSecret'])).toBe(true);
    expect(isSecretKeyPath(['adapterOptions', 'llm', 'maxTokens'])).toBe(false);
    expect(isSecretKeyPath(['platform', 'adapters', 'llm'])).toBe(false);
  });

  it('recognises well-known credential shapes only', () => {
    expect(looksLikeSecretValue('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(true);
    expect(looksLikeSecretValue('AKIAABCDEFGHIJKLMNOP')).toBe(true);
    expect(looksLikeSecretValue('gpt-4o')).toBe(false);
    expect(looksLikeSecretValue('@kb-labs/adapters-openai')).toBe(false);
    expect(looksLikeSecretValue(42)).toBe(false);
  });

  it('ignores empty strings and references when scanning', () => {
    expect(findPlainSecrets(['apiKey'], '')).toEqual([]);
    expect(findPlainSecrets(['apiKey'], '${X}')).toEqual([]);
    expect(findPlainSecrets(['a'], { token: 'x', n: 1 })).toEqual([{ path: ['a', 'token'], reason: 'secret-key' }]);
  });
});

describe('schema key resolution', () => {
  it('finds the closest key', () => {
    expect(editDistance('adaptors', 'adapters')).toBe(1);
    expect(suggestKey('adaptors', ['adapters', 'core'])).toBe('adapters');
    expect(suggestKey('zzz', ['adapters', 'core'])).toBeUndefined();
    expect(suggestKey('core', ['core'])).toBeUndefined();
  });

  it('resolves through optional wrappers, catchall and unions', () => {
    expect(resolveKeyPath(TEST_SCHEMA, ['platform', 'adapters', 'llm']).status).toBe('ok');
    expect(resolveKeyPath(TEST_SCHEMA, ['platform', 'adapters', 'brandNew']).status).toBe('ok');
    const unknown = resolveKeyPath(TEST_SCHEMA, ['platfrom', 'adapters']);
    expect(unknown).toMatchObject({ status: 'unknown', key: 'platfrom', suggestion: 'platform' });
  });
});

describe('withFileLock', () => {
  it('times out with a typed error and releases after the holder finishes', async () => {
    const target = path.join(dir, 'x.json');
    await withFileLock(target, async () => {
      await expect(withFileLock(target, async () => 1, { timeoutMs: 40, retryDelayMs: 5 })).rejects.toBeInstanceOf(
        FileLockTimeoutError,
      );
    });
    await expect(withFileLock(target, async () => 'ok')).resolves.toBe('ok');
  });

  it('reclaims a lock whose owner process is gone', async () => {
    const target = path.join(dir, 'y.json');
    await fsp.writeFile(`${target}.lock`, '2147483646\n2020-01-01T00:00:00.000Z\n');
    await expect(withFileLock(target, async () => 'ok', { timeoutMs: 500 })).resolves.toBe('ok');
  });

  it('releases the lock when the callback throws', async () => {
    const target = path.join(dir, 'z.json');
    await expect(
      withFileLock(target, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(withFileLock(target, async () => 'ok')).resolves.toBe('ok');
  });
});
