import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function generatedPackageManifests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return generatedPackageManifests(path);
    return entry.isFile() && entry.name === 'generated-packages.txt' ? [path] : [];
  });
}

export function clearGeneratedReleasePackages(packagesDirectory, outputDirectory) {
  const packagesRoot = resolve(packagesDirectory);
  for (const manifestPath of generatedPackageManifests(resolve(outputDirectory))) {
    for (const filename of readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const packagePath = resolve(packagesRoot, filename);
      if (dirname(packagePath) !== packagesRoot) {
        throw new Error(`generated package manifest contains a path outside its package directory: ${filename}`);
      }
      rmSync(packagePath, { force: true });
    }
  }
}

export function readPackedPackageManifests(packagesDirectory) {
  const root = resolve(packagesDirectory);
  return readdirSync(root)
    .filter(filename => filename.endsWith('.tgz'))
    .sort()
    .map(filename => {
      const artifactPath = join(root, filename);
      const packageJSON = JSON.parse(execFileSync('tar', ['-xOzf', artifactPath, 'package/package.json'], { encoding: 'utf8' }));
      return { filename, artifactPath, packageJSON };
    });
}

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const packagesDirectory = value('--packages-dir');
  const outputDirectory = value('--output-dir');
  if (!packagesDirectory || !outputDirectory) throw new Error('--packages-dir and --output-dir are required');
  clearGeneratedReleasePackages(packagesDirectory, outputDirectory);
}
