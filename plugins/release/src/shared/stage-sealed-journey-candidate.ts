import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
  for (const binary of binaryManifest.binaries ?? []) {
    if (typeof binary.filename !== 'string' || !binary.filename || binary.filename.includes('/') || binary.filename.includes('\\')) {
      throw new Error('Sealed candidate binary manifest contains an invalid filename');
    }
    const source = filesByDigest.get(binary.sha256);
    if (!source || statSync(source).size !== binary.sizeBytes) {
      throw new Error(`Sealed candidate bundle is missing the exact binary bytes for ${binary.filename}`);
    }
    copyFileSync(source, join(candidateRoot, binary.filename));
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
