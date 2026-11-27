import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { PluginSettingsSchemaLoadError} from '../plugin-settings-schema.js';
import { resolvePluginSettingsValidator } from '../plugin-settings-schema.js';

let temporaryRoot: string;

async function makePluginRoot(): Promise<string> {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-plugin-settings-schema-'));
  return temporaryRoot;
}

afterEach(async () => {
  if (temporaryRoot) {await fs.rm(temporaryRoot, { recursive: true, force: true });}
});

describe('resolvePluginSettingsValidator', () => {
  it('compiles inline JSON Schema', async () => {
    const root = await makePluginRoot();
    const validator = await resolvePluginSettingsValidator({
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
      additionalProperties: false,
    }, root, 'sample');

    expect(await validator.validate({ enabled: true })).toEqual({ valid: true });
    expect((await validator.validate({ enabled: 'yes' })).valid).toBe(false);
  });

  it('resolves a local JSON Schema reference and JSON Pointer', async () => {
    const root = await makePluginRoot();
    await fs.writeFile(path.join(root, 'settings.schema.json'), JSON.stringify({
      $defs: { settings: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } },
    }));
    const validator = await resolvePluginSettingsValidator({ $ref: './settings.schema.json#/$defs/settings' }, root, 'sample');

    expect(await validator.validate({ count: 2 })).toEqual({ valid: true });
    expect((await validator.validate({ count: '2' })).valid).toBe(false);
  });

  it('resolves a module SchemaRef to an exported Zod-compatible schema', async () => {
    const root = await makePluginRoot();
    await fs.writeFile(path.join(root, 'settings.mjs'), `
      export const SettingsSchema = {
        safeParse(value) {
          return typeof value?.name === 'string'
            ? { success: true, data: value }
            : { success: false, error: { issues: [{ path: ['name'], message: 'Expected string' }] } };
        },
      };
    `);
    const validator = await resolvePluginSettingsValidator({ zod: './settings.mjs#SettingsSchema' }, root, 'sample');

    expect(await validator.validate({ name: 'Ada' })).toEqual({ valid: true });
    expect(await validator.validate({ name: 1 })).toEqual({ valid: false, cause: 'name: Expected string' });
  });

  // case: S-204.13
  it('loads and validates a plugin schema in a separate process', async () => {
    const root = await makePluginRoot();
    const marker = path.join(root, 'pids.json');
    await fs.writeFile(path.join(root, 'settings.mjs'), `
      import { appendFileSync } from 'node:fs';
      console.log('plugin import output must not corrupt the result channel');
      appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ event: 'import', pid: process.pid }) + '\\n');
      export const SettingsSchema = {
        safeParse(value) {
          console.log('plugin validation output must not corrupt the result channel');
          appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ event: 'validate', pid: process.pid }) + '\\n');
          return typeof value?.name === 'string'
            ? { success: true, data: value }
            : { success: false, error: { issues: [{ path: ['name'], message: 'Expected string' }] } };
        },
      };
    `);
    const validator = await resolvePluginSettingsValidator({ zod: './settings.mjs#SettingsSchema' }, root, 'sample');

    expect(await validator.validate({ name: 'Ada' })).toEqual({ valid: true });
    const events = (await fs.readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { event: string; pid: number });
    expect(events.map(({ event }) => event)).toEqual(['import', 'import', 'validate']);
    expect(events.every(({ pid }) => pid !== process.pid)).toBe(true);
  });

  // case: S-204.13
  it('fails a stalled plugin validator within its bounded lifetime', async () => {
    const root = await makePluginRoot();
    const marker = path.join(root, 'called');
    await fs.writeFile(path.join(root, 'settings.mjs'), `
      import { writeFileSync } from 'node:fs';
      export const SettingsSchema = { safeParse() {
        writeFileSync(${JSON.stringify(marker)}, 'started');
        while (true) {}
      } };
    `);
    const validator = await resolvePluginSettingsValidator({ zod: './settings.mjs#SettingsSchema' }, root, 'sample');

    const validation = await validator.validate({ name: 'Ada' });
    expect(validation).toMatchObject({ valid: false });
    if (!validation.valid) {expect(validation.cause).toMatch(/timed out/i);}
    expect(await fs.readFile(marker, 'utf8')).toBe('started');
  }, 10_000);

  // case: S-204.13
  it('loads a Zod v3 schema from the plugin package dependency tree', async () => {
    const root = await makePluginRoot();
    const zodRoot = path.dirname(fileURLToPath(import.meta.resolve('zod')));
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
    await fs.symlink(zodRoot, path.join(root, 'node_modules', 'zod'), 'dir');
    await fs.writeFile(path.join(root, 'settings.mjs'), `
      import { z } from 'zod/v3';
      export const SettingsSchema = z.object({ name: z.string() });
    `);
    const validator = await resolvePluginSettingsValidator({ zod: './settings.mjs#SettingsSchema' }, root, 'sample');

    expect(await validator.validate({ name: 'Ada' })).toEqual({ valid: true });
    expect((await validator.validate({ name: 42 })).valid).toBe(false);
  });

  it('returns a typed schema error for an unresolved reference', async () => {
    const root = await makePluginRoot();
    await expect(resolvePluginSettingsValidator({ zod: './missing.mjs#SettingsSchema' }, root, 'sample'))
      .rejects.toMatchObject({ code: 'KB_PLUGIN_SETTINGS_SCHEMA_INVALID', plugin: 'sample' } satisfies Partial<PluginSettingsSchemaLoadError>);
  });
});
