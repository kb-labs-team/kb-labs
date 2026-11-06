import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEntity, build } from '@kb-labs/scaffold-core';
import {
  isManifestV3,
  validateManifest,
  type ManifestV3,
} from '@kb-labs/sdk/contracts';
import type { RenderContext } from '@kb-labs/scaffold-contracts';

const here = dirname(fileURLToPath(import.meta.url));
const templatesRoot = resolve(here, '..', 'templates');

const baseCtx: RenderContext = {
  name: 'demo',
  scope: '@kb-labs',
  vars: {
    description: 'A demo plugin',
    license: 'MIT',
    mode: 'in-workspace',
  },
  blocks: [],
  mode: 'in-workspace',
  versions: { sdk: '2.18.0', devkit: '2.28.0' },
};

async function buildFor(blocks: string[]) {
  const entity = await loadEntity(templatesRoot, 'plugin');
  return build({
    entity,
    selectedBlockIds: blocks,
    context: { ...baseCtx, blocks },
  });
}

describe('generated plugin manifest passes V3 validation', () => {
  const combos: string[][] = [
    ['base'],
    ['base', 'cli'],
    ['base', 'cli', 'rest'],
    ['base', 'cli', 'contracts'],
    ['base', 'cli', 'rest', 'contracts'],
  ];

  for (const blocks of combos) {
    it(`is V3-valid for: ${blocks.join(' + ')}`, async () => {
      const { manifest } = await buildFor(blocks);

      expect(isManifestV3(manifest)).toBe(true);

      const { valid, errors } = validateManifest(manifest as ManifestV3);
      expect(errors).toEqual([]);
      expect(valid).toBe(true);

      // Every command handler path must be resolvable (start with ./).
      const cmds = (manifest as { cli?: { commands?: Array<{ handler?: string; path?: string; id?: string }> } })
        .cli?.commands ?? [];
      for (const cmd of cmds) {
        expect(cmd.handler).toMatch(/^\.\//);

        // B-013: commands must use `path` (space-separated tokens like "demo hello"),
        // not legacy `id`+`group`. discover.ts reads cmd.path to build segments[];
        // missing path → segments=[] → MANIFEST_VALIDATION_FAILED → plugin unusable.
        expect(typeof cmd.path).toBe('string');
        expect(cmd.path!.trim().split(/\s+/).length).toBeGreaterThanOrEqual(2);
        expect(cmd.id).toBeUndefined();
      }
    });
  }
});

describe('generated plugin files are type-safe', () => {
  it('uses the configured npm channel for generated package specs', async () => {
    const entity = await loadEntity(templatesRoot, 'plugin');
    const { files } = await build({
      entity,
      selectedBlockIds: ['base', 'cli'],
      context: {
        ...baseCtx,
        blocks: ['base', 'cli'],
        versions: { ...baseCtx.versions, sdkSpec: 'canary', devkitSpec: 'canary', commandKitSpec: 'canary' },
      },
    });
    const packageFile = files.find(f => f.path === 'package.json');
    expect(packageFile?.contents).toContain('"@kb-labs/sdk": "canary"');
    expect(packageFile?.contents).not.toContain('"@kb-labs/shared-command-kit"');
  });

  it('error.ts validationError signature takes (ctx, message, isJson?) — no hint param', async () => {
    const { files } = await buildFor(['base']);
    const errorFile = files.find(f => f.path.includes('utils/error'));
    expect(errorFile).toBeDefined();

    // B-020: hint parameter was removed from validationError() because MessageOptions.hint
    // is not present in all published SDK versions, causing TS2353/TS2554 errors.
    // The signature must be (ctx, message, isJson?) with no hint.
    const src = errorFile!.contents;
    expect(src).toContain('export function validationError(');
    expect(src).not.toMatch(/validationError\([\s\S]*?hint\??\s*:/);
  });

  it('error.ts validationError call in hello command matches updated signature', async () => {
    const { files } = await buildFor(['base']);
    const helloFile = files.find(f => f.path.includes('commands/hello'));
    expect(helloFile).toBeDefined();

    // B-020: hello.ts was calling validationError(ctx, msg, hint, isJson) — 4 args.
    // After fix: validationError(ctx, msg, isJson) — 3 args max.
    const src = helloFile!.contents;
    const match = src.match(/validationError\(([^)]+)\)/);
    if (match) {
      const args = match[1].split(',').map(s => s.trim()).filter(Boolean);
      expect(args.length).toBeLessThanOrEqual(3);
    }
  });
});
