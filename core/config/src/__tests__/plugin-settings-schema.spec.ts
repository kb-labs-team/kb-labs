import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

    expect(validator.validate({ enabled: true })).toEqual({ valid: true });
    expect(validator.validate({ enabled: 'yes' }).valid).toBe(false);
  });

  it('resolves a local JSON Schema reference and JSON Pointer', async () => {
    const root = await makePluginRoot();
    await fs.writeFile(path.join(root, 'settings.schema.json'), JSON.stringify({
      $defs: { settings: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } },
    }));
    const validator = await resolvePluginSettingsValidator({ $ref: './settings.schema.json#/$defs/settings' }, root, 'sample');

    expect(validator.validate({ count: 2 })).toEqual({ valid: true });
    expect(validator.validate({ count: '2' }).valid).toBe(false);
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

    expect(validator.validate({ name: 'Ada' })).toEqual({ valid: true });
    expect(validator.validate({ name: 1 })).toEqual({ valid: false, cause: 'name: Expected string' });
  });

  it('returns a typed schema error for an unresolved reference', async () => {
    const root = await makePluginRoot();
    await expect(resolvePluginSettingsValidator({ zod: './missing.mjs#SettingsSchema' }, root, 'sample'))
      .rejects.toMatchObject({ code: 'KB_PLUGIN_SETTINGS_SCHEMA_INVALID', plugin: 'sample' } satisfies Partial<PluginSettingsSchemaLoadError>);
  });
});
