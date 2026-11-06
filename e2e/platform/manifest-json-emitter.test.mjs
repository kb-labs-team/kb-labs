import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { emitManifestJson } from '@kb-labs/devkit/tsup/emit-manifest-json.mjs';

test('shared manifest emitter serializes only the named manifest export', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'kb-manifest-json-emitter-'));
  try {
    const modulePath = join(fixture, 'manifest.mjs');
    const outputPath = join(fixture, 'package', 'dist', 'manifest.json');
    const manifest = { schema: 'kb.adapter/1', id: '@kb-labs/fixture-adapter', version: '1.0.0' };
    writeFileSync(modulePath,
      `export const manifest = ${JSON.stringify(manifest)};\nexport default { schema: 'wrong-shape' };\n`);

    await emitManifestJson({ manifestModule: modulePath, outputPath });

    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), manifest);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('adapter manifest emission derives kb-create credential requirements from configSchema', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'kb-adapter-requirements-emitter-'));
  try {
    const modulePath = join(fixture, 'manifest.mjs');
    const outputPath = join(fixture, 'package', 'dist', 'manifest.json');
    const manifest = {
      schema: 'kb.adapter/1', id: 'openai-llm', version: '1.0.0', defaultFor: { llm: ['llm'] },
      configSchema: {
        apiKey: {
          type: 'string', required: true, secret: true, env: 'OPENAI_API_KEY',
          doctor: [{
            slot: 'llm', id: 'openai.apiKey', optional: true, severity: 'warning', services: ['gateway'],
            action: 'set OPENAI_API_KEY to enable LLM features', hint: 'set OPENAI_API_KEY',
          }],
        },
      },
    };
    writeFileSync(modulePath, `export const manifest = ${JSON.stringify(manifest)};\n`);

    await emitManifestJson({ manifestModule: modulePath, outputPath });

    const requirements = JSON.parse(readFileSync(join(fixture, 'package', 'dist', 'kb-create.requirements.json'), 'utf8'));
    assert.deepEqual(requirements, {
      schema: 'kb.create.requirements/v1',
      requirements: [{
        id: 'openai.apiKey', path: '/platform/adapterOptions/llm/apiKey', required: true,
        optional: true, severity: 'warning', secret: true, env: 'OPENAI_API_KEY',
        services: ['gateway'], action: 'set OPENAI_API_KEY to enable LLM features', hint: 'set OPENAI_API_KEY',
      }],
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
