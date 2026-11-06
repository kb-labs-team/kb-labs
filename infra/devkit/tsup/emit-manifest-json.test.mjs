import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { emitManifestJson } from './emit-manifest-json.mjs';

test('emits distinct credential requirements for every doctor-declared default slot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kb-manifest-requirements-'));
  try {
    const manifestPath = join(directory, 'manifest.mjs');
    const outputPath = join(directory, 'dist', 'manifest.json');
    await writeFile(manifestPath, `export const manifest = ${JSON.stringify({
      schema: 'kb.adapter/1',
      id: 'openai',
      defaultFor: { llm: ['llm'], embeddings: ['embeddings'] },
      configSchema: {
        apiKey: {
          type: 'string',
          required: true,
          secret: true,
          env: 'OPENAI_API_KEY',
          doctor: [
            {
              slot: 'llm',
              id: 'openai.apiKey',
              optional: true,
              severity: 'warning',
              services: ['gateway'],
              action: 'set OPENAI_API_KEY to enable LLM features',
              hint: 'configure the key',
            },
            {
              slot: 'embeddings',
              id: 'openai.embeddings.apiKey',
              optional: true,
              severity: 'warning',
              services: ['gateway'],
              action: 'set OPENAI_API_KEY to enable embeddings',
              hint: 'configure the key',
            },
          ],
        },
      },
    })};`);

    await emitManifestJson({ manifestModule: manifestPath, outputPath });
    const output = JSON.parse(await readFile(join(directory, 'dist', 'kb-create.requirements.json'), 'utf8'));
    assert.deepEqual(output.requirements.map(({ id, path, action }) => ({ id, path, action })), [
      {
        id: 'openai.apiKey',
        path: '/platform/adapterOptions/llm/apiKey',
        action: 'set OPENAI_API_KEY to enable LLM features',
      },
      {
        id: 'openai.embeddings.apiKey',
        path: '/platform/adapterOptions/embeddings/apiKey',
        action: 'set OPENAI_API_KEY to enable embeddings',
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
