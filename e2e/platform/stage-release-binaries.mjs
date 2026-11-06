import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [artifactsPath, outputDirectory] = process.argv.slice(2);
if (!artifactsPath || !outputDirectory) throw new Error('usage: stage-release-binaries.mjs ARTIFACTS OUTPUT_DIRECTORY');
const artifacts = JSON.parse(readFileSync(artifactsPath, 'utf8'));
mkdirSync(outputDirectory, { recursive: true });
for (const artifact of artifacts) {
  if (artifact.type === 'Binary' && artifact.extra?.Checksum) {
    copyFileSync(artifact.path, join(outputDirectory, artifact.name));
  }
}
