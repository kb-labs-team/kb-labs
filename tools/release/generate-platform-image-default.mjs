import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlatformReleaseConfig } from '../kb-create/scripts/platform-release-config.mjs';

const outputPath = resolve(process.argv[2] ?? '.kb/deploy/image-default/kb.config.json');
const releaseConfigPath = fileURLToPath(new URL('../kb-create/config/platform-release.jsonc', import.meta.url));
const platformLayoutPath = fileURLToPath(new URL('../kb-create/v2/contracts/platform-layout.json', import.meta.url));
const { marketplaceSources, marketplaceCatalogRegistry } = readPlatformReleaseConfig(releaseConfigPath);
const config = {
  platform: { deployment: { topology: 'cloud' } },
  marketplace: { sources: marketplaceSources, catalogRegistry: marketplaceCatalogRegistry },
  gateway: {
    access: { mode: 'secured' },
    auth: { bootstrap: { adminEmail: 'admin@example.com' } },
  },
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`);
await writeFile(resolve(dirname(outputPath), 'platform-layout.json'), await readFile(platformLayoutPath));
