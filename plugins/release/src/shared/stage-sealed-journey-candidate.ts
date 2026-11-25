import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { VerifiedCandidateBundle } from './candidate-bundle.js';

interface CandidateBinary {
  filename: string;
  sha256: string;
  sizeBytes: number;
  url?: string;
}

interface CandidateBinaryManifest {
  binaries: CandidateBinary[];
  [key: string]: unknown;
}

export function stageSealedJourneyCandidate({ bundleDir, packagesDir, candidateDir, verified }: {
  bundleDir: string;
  packagesDir: string;
  candidateDir: string;
  verified: VerifiedCandidateBundle;
}): void {
  const root = resolve(bundleDir);
  const releaseRoot = resolve(candidateDir, '..');
  const packageRoot = resolve(packagesDir);
  const candidateRoot = resolve(candidateDir);
  mkdirSync(packageRoot, { recursive: true });
  for (const artifact of verified.artifacts) {
    copyFileSync(join(verified.artifactsDir, artifact.tarball), join(packageRoot, artifact.tarball));
  }

  mkdirSync(candidateRoot, { recursive: true });
  copyFileSync(join(root, 'release-index.json'), join(candidateRoot, 'release-index.json'));
  copyFileSync(join(root, 'binary-manifest.json'), join(candidateRoot, 'binary-manifest.json'));
  const binaryManifest = JSON.parse(readFileSync(join(root, 'binary-manifest.json'), 'utf8')) as CandidateBinaryManifest;
  const binaryFiles: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) binaryFiles.push(path);
    }
  };
  walk(join(root, 'binaries'));
  const filesByDigest = new Map(binaryFiles.map(path => [
    createHash('sha256').update(readFileSync(path)).digest('hex'), path,
  ]));
  const mirroredBinaries = new Map<string, CandidateBinary[]>();
  for (const binary of binaryManifest.binaries ?? []) {
    if (typeof binary.filename !== 'string' || !binary.filename || binary.filename.includes('/') || binary.filename.includes('\\')) {
      throw new Error('Sealed candidate binary manifest contains an invalid filename');
    }
    const source = filesByDigest.get(binary.sha256);
    if (!source || statSync(source).size !== binary.sizeBytes) {
      throw new Error(`Sealed candidate bundle is missing the exact binary bytes for ${binary.filename}`);
    }
    const staged = join(candidateRoot, binary.filename);
    copyFileSync(source, staged);
    chmodSync(staged, 0o755);
    const signedUrl = binary.url;
    if (typeof signedUrl !== 'string') throw new Error(`Sealed candidate binary has no signed URL: ${binary.filename}`);
    const releaseParts = new URL(signedUrl).pathname.split('/').filter(Boolean);
    const signedTag = releaseParts.at(-2);
    if (!signedTag || releaseParts.at(-1) !== binary.filename || signedTag.includes('..')) {
      throw new Error(`Sealed candidate binary URL has no valid release tag: ${binary.filename}`);
    }
    const mirrorDirectory = join(releaseRoot, signedTag);
    mkdirSync(mirrorDirectory, { recursive: true });
    const mirrorBinary = join(mirrorDirectory, binary.filename);
    copyFileSync(source, mirrorBinary);
    chmodSync(mirrorBinary, 0o755);
    const group = mirroredBinaries.get(signedTag) ?? [];
    group.push(binary);
    mirroredBinaries.set(signedTag, group);
  }
  const allowedTarballs = new Set(verified.artifacts.map(artifact => artifact.tarball));
  const addReferencedTarballs = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(addReferencedTarballs);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if ((key === 'tarball' || key === 'url') && typeof child === 'string' && child.includes('.tgz')) {
          try {
            const filename = decodeURIComponent(new URL(child).pathname.split('/').at(-1) ?? child);
            if (filename.endsWith('.tgz') && !filename.includes('/') && !filename.includes('\\')) allowedTarballs.add(filename);
          } catch {
            const filename = child.split(/[/?#]/).at(-1);
            if (filename?.endsWith('.tgz') && !filename.includes('\\')) allowedTarballs.add(filename);
          }
        }
        addReferencedTarballs(child);
      }
    }
  };
  for (const filename of readdirSync(candidateRoot).filter(name => /^release-index.*\.json$/.test(name))) {
    try { addReferencedTarballs(JSON.parse(readFileSync(join(candidateRoot, filename), 'utf8')) as unknown); }
    catch (error) { throw new Error(`Journey release index ${filename} is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const filename of readdirSync(packageRoot).filter(name => name.endsWith('.tgz') && !allowedTarballs.has(name))) {
    unlinkSync(join(packageRoot, filename));
  }
  for (const [tag, binaries] of mirroredBinaries) {
    const checksums = binaries.map(binary => `${binary.sha256}  ${binary.filename}\n`).join('');
    writeFileSync(join(releaseRoot, tag, 'checksums.txt'), checksums);
  }
  // Keep the signed catalog byte-identical: its signature covers URLs as well
  // as hashes. Installer smoke redirects only the binary source via the
  // supported --binary-source/KB_CREATE_DOWNLOAD_BASE_URL override.
  const files: string[] = [];
  const collect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile() && entry.name !== 'checksums.txt') files.push(path);
    }
  };
  collect(candidateRoot);
  const checksumLines = files.sort().map(path => {
    const name = path.slice(candidateRoot.length + 1);
    return `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${name}\n`;
  }).join('');
  writeFileSync(join(candidateRoot, 'checksums.txt'), checksumLines);
  writeFileSync(join(candidateRoot, 'candidate-bundle-digest.txt'), `${verified.provenance.bundleDigest}\n`);
}
