#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const required = name => {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
};

const versionsFile = resolve(required('--versions'));
const output = resolve(required('--output'));
const assetBaseURL = required('--asset-base-url').replace(/\/$/, '');
const commit = required('--commit');
const parsedBaseURL = new URL(assetBaseURL);
if (!['http:', 'https:'].includes(parsedBaseURL.protocol) || parsedBaseURL.search || parsedBaseURL.hash) {
  throw new Error('--asset-base-url must be an absolute HTTP(S) URL without query or fragment');
}
const versions = JSON.parse(readFileSync(versionsFile, 'utf8'));
if (!Array.isArray(versions) || versions.length === 0) throw new Error('versions file must be a non-empty array');
const uniqueVersions = [...new Set(versions)];
if (uniqueVersions.some(version => typeof version !== 'string' || !/^[0-9][0-9A-Za-z.+-]*$/.test(version))) {
  throw new Error('versions file contains an invalid platform version');
}

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../tools/kb-create');
const manifestsDirectory = join(output, 'binary-manifests');
mkdirSync(manifestsDirectory, { recursive: true });
const manifestPaths = {};
const targets = [
  { os: 'darwin', arch: 'amd64' },
  { os: 'darwin', arch: 'arm64' },
  { os: 'linux', arch: 'amd64' },
  { os: 'linux', arch: 'arm64' },
];

for (const version of uniqueVersions) {
  const versionDirectory = join(output, 'binaries', version);
  mkdirSync(versionDirectory, { recursive: true });
  const binaries = [];
  for (const { os, arch } of targets) {
    const binaryFilename = `kb-create-${os}-${arch}`;
    const binaryPath = join(versionDirectory, binaryFilename);
    const build = spawnSync('go', [
      'build', '-trimpath',
      '-ldflags', `-s -w -X main.version=${version} -X main.commit=${commit}`,
      '-o', binaryPath, '.',
    ], {
      cwd: moduleRoot,
      env: { ...process.env, CGO_ENABLED: '0', GOOS: os, GOARCH: arch },
      encoding: 'utf8',
    });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(`build kb-create ${version} ${os}/${arch} failed: ${build.stderr || build.stdout}`);

    if (os === 'linux' && arch === 'amd64') {
      const versionCheck = spawnSync(binaryPath, ['--version'], { encoding: 'utf8' });
      if (versionCheck.error) throw versionCheck.error;
      if (versionCheck.status !== 0 || versionCheck.stdout.trim() !== `kb-create ${version}`) {
        throw new Error(`built kb-create binary does not report target ${version}: ${versionCheck.stdout || versionCheck.stderr}`);
      }
    }

    const digest = data => createHash('sha256').update(data).digest('hex');
    const bytes = readFileSync(binaryPath);
    const sha256 = digest(bytes);
    const stagedPath = join(versionDirectory, basename(binaryPath));
    if (digest(readFileSync(stagedPath)) !== sha256) throw new Error(`staged binary checksum mismatch for ${version} ${os}/${arch}`);
    binaries.push({
      id: 'kb-create',
      version,
      os,
      arch,
      filename: binaryFilename,
      sha256,
      sizeBytes: statSync(binaryPath).size,
      url: `${assetBaseURL}/binaries/${encodeURIComponent(version)}/${binaryFilename}`,
    });
  }
  const manifestPath = join(manifestsDirectory, `${version}.json`);
  writeFileSync(manifestPath, `${JSON.stringify({ binaries }, null, 2)}\n`);
  manifestPaths[version] = manifestPath;
}

writeFileSync(join(output, 'binary-manifest-map.json'), `${JSON.stringify(manifestPaths, null, 2)}\n`);
