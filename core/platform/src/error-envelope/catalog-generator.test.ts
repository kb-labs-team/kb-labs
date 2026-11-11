import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(sourceDirectory, 'errors.catalog.json');
const generatorPath = join(sourceDirectory, '../../scripts/generate-error-codes.mjs');

describe('error code catalog generator', () => {
  it('refuses catalog entries without an HTTP status', async () => {
    await expectGeneratorRefusal('httpStatus');
  });

  it('refuses catalog entries without a process exit class', async () => {
    await expectGeneratorRefusal('processExitClass');
  });
});

async function expectGeneratorRefusal(field: 'httpStatus' | 'processExitClass'): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'kb-error-catalog-generator-'));
  const source = join(root, 'src/error-envelope');
  const scripts = join(root, 'scripts');
  try {
    await mkdir(source, { recursive: true });
    await mkdir(scripts, { recursive: true });
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
      codes: Array<Record<string, unknown>>;
    };
    delete catalog.codes[0]?.[field];
    await writeFile(join(source, 'errors.catalog.json'), JSON.stringify(catalog));
    await cp(generatorPath, join(scripts, 'generate-error-codes.mjs'));

    const result = spawnSync(process.execPath, [join(scripts, 'generate-error-codes.mjs')], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must declare');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
