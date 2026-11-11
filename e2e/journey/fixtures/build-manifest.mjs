import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const packageDirectory = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('fixture package directory is required');
const workspaceRoot = resolve(packageDirectory, '../../../..');
const packageManifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
const manifestModule = packageManifest.kb?.adapter?.manifest ?? packageManifest.kb?.manifest;
if (typeof manifestModule !== 'string' || !manifestModule.startsWith('./')) {
  throw new Error(`${packageManifest.name} must declare its KB manifest module in package.json`);
}
const outputDirectory = resolve(packageDirectory, 'dist');
mkdirSync(outputDirectory, { recursive: true });
const sourceDirectory = resolve(packageDirectory, 'src');
if (existsSync(sourceDirectory)) cpSync(sourceDirectory, outputDirectory, { recursive: true, force: true });
const modulePath = resolve(packageDirectory, manifestModule);
cpSync(resolve(packageDirectory, 'manifest.js'), modulePath);
const outputPath = join(dirname(modulePath), 'manifest.json');
execFileSync(process.execPath, [
  resolve(workspaceRoot, 'infra/devkit/tsup/emit-manifest-json.mjs'),
  '--module', modulePath,
  '--output', outputPath,
], { stdio: 'inherit' });
