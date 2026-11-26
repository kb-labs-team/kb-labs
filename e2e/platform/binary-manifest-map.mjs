import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function binaryManifestForVersion(version, fallbackPath, mapPath) {
  if (!mapPath) return fallbackPath;
  const mapping = JSON.parse(readFileSync(mapPath, 'utf8'));
  const mappedPath = mapping[version];
  if (typeof mappedPath !== 'string' || mappedPath.length === 0) {
    throw new Error(`binary manifest map has no entry for platform version ${version}`);
  }
  const manifestPath = resolve(dirname(mapPath), mappedPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.binaries) || manifest.binaries.length === 0
      || manifest.binaries.some(binary => binary.version !== version)) {
    throw new Error(`binary manifest for platform version ${version} contains a different binary version`);
  }
  return manifestPath;
}
