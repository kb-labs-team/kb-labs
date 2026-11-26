import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

export function ensureBinaryManifestDirectory(outputPath) {
  const directory = join(resolve(outputPath, '..'), 'binary-manifests');
  mkdirSync(directory, { recursive: true });
  return directory;
}

const goArchitectures = { x64: 'amd64', arm64: 'arm64' };

export function isNativeBinaryTarget(os, arch, platform = process.platform, processArch = process.arch) {
  const goOS = { darwin: 'darwin', linux: 'linux' }[platform];
  return os === goOS && arch === goArchitectures[processArch];
}

export function binaryPathsForChecksums(baseManifestPath, mapPath) {
  const paths = JSON.parse(readFileSync(baseManifestPath, 'utf8')).binaries.map(binary => binary.filename);
  const mapping = JSON.parse(readFileSync(mapPath, 'utf8'));
  for (const [version, manifestPath] of Object.entries(mapping)) {
    const manifest = JSON.parse(readFileSync(resolve(dirname(mapPath), manifestPath), 'utf8'));
    for (const binary of manifest.binaries) paths.push(`binaries/${version}/${binary.filename}`);
  }
  return paths;
}

export function verifyNativeBinaryVersion(manifestPath, platform = process.platform, processArch = process.arch) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const binary = manifest.binaries.find(entry => entry.id === 'kb-create'
    && isNativeBinaryTarget(entry.os, entry.arch, platform, processArch));
  if (!binary) return false;
  const binaryPath = join(dirname(resolve(manifestPath)), binary.filename);
  const result = spawnSync(binaryPath, ['--version'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  const actual = result.stdout.trim();
  const expected = `kb-create ${binary.version}`;
  if (result.status !== 0 || actual !== expected) {
    throw new Error(`native kb-create binary identity mismatch: manifest=${expected}, binary=${actual || result.stderr.trim()}`);
  }
  return true;
}

export function verifyManifestBinaryFiles(manifestPath) {
  const directory = dirname(resolve(manifestPath));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const binary of manifest.binaries) {
    const bytes = readFileSync(join(directory, binary.filename));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== binary.sha256 || bytes.byteLength !== binary.sizeBytes) {
      throw new Error(`staged GoReleaser binary does not match its manifest: ${binary.filename}`);
    }
  }
  return true;
}

export function binaryManifestForVersion(version, fallbackPath, mapPath, baseVersion) {
  if (!mapPath) return fallbackPath;
  const mapping = JSON.parse(readFileSync(mapPath, 'utf8'));
  const mappedPath = mapping[version];
  if (typeof mappedPath !== 'string' || mappedPath.length === 0) {
    if (version === baseVersion) return fallbackPath;
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
