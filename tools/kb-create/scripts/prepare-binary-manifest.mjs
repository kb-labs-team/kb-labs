#!/usr/bin/env node

// Converts the exact GoReleaser checksum output into the binary part of the
// unified release-index input. It never resolves a channel or a "latest"
// release; the tag and asset bytes are explicit inputs.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

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

const checksumsPath = required('--checksums');
const artifactsPath = required('--artifacts');
const repository = required('--repository');
const releaseTag = required('--release-tag');
const version = required('--version');
const output = required('--output');
const assetBaseURL = value('--asset-base-url');
if (assetBaseURL) {
  let parsed;
  try {
    parsed = new URL(assetBaseURL);
  } catch {
    throw new Error('--asset-base-url must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
    throw new Error('--asset-base-url must be an absolute HTTP(S) URL without query or fragment');
  }
}
// Author and ops tools are not part of a user installation (ADR-0045): the
// index lists only what the launcher may install. kb-dev in particular is how
// platform authors run services from the monorepo, never how a user runs one.
const AUTHOR_AND_OPS_TOOLS = new Set(['kb-dev', 'kb-devkit', 'kb-env', 'kb-deploy', 'kb-monitor']);
const checksums = new Map();
for (const line of readFileSync(checksumsPath, 'utf8').split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
  const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
  if (!match) continue;
  const [, sha256, filename] = match;
  if (checksums.has(filename)) throw new Error(`duplicate checksum asset ${filename}`);
  checksums.set(filename, sha256.toLowerCase());
}
const artifacts = JSON.parse(readFileSync(artifactsPath, 'utf8'));
if (!Array.isArray(artifacts)) throw new Error('GoReleaser artifacts output must be an array');
const binaries = [];
const config = resolve(value('--config') ?? process.env.KBLABS_RELEASE_GORELEASER_CONFIG ?? '.goreleaser.yaml');
const sealer = process.env.KBLABS_RELEASE_INDEX_SEALER;
const targetCommand = sealer ? [sealer, ['targets', config, 'kb-create']] : ['go', ['run', './v2/cmd/kb-create-release-index', 'targets', config, 'kb-create']];
const targetResult = spawnSync(targetCommand[0], targetCommand[1], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
if (targetResult.status !== 0) throw new Error(`GoReleaser target projection failed: ${targetResult.stderr || targetResult.error}`);
const supportedTargets = JSON.parse(targetResult.stdout);
const seen = new Set();

for (const artifact of artifacts) {
  if (artifact.type !== 'Binary' || !artifact.extra?.Checksum) continue;
  const { name: filename, path: artifactPath, goos: os, goarch: arch, extra } = artifact;
  const id = extra.Binary;
  const sha256 = checksums.get(filename);
  if (!id || !os || !arch || !artifactPath) {
    throw new Error(`GoReleaser binary artifact ${filename} lacks its identity or output path`);
  }
  if (!sha256) throw new Error(`GoReleaser binary artifact ${filename} is missing from checksums`);
  if (AUTHOR_AND_OPS_TOOLS.has(id)) continue;
  const key = `${id}:${os}/${arch}`;
  if (seen.has(key)) throw new Error(`duplicate binary asset ${key}`);
  seen.add(key);
  binaries.push({
    id,
    version,
    os,
    arch,
    filename,
    sha256,
    sizeBytes: statSync(resolve(artifactPath)).size,
    url: assetBaseURL
      ? `${assetBaseURL.replace(/\/$/, '')}/${filename}`
      : `https://github.com/${repository}/releases/download/${releaseTag}/${filename}`,
  });
}

if (binaries.length === 0) throw new Error('checksums file contains no KB Labs binary assets');
binaries.sort((left, right) => `${left.id}:${left.os}/${left.arch}`.localeCompare(`${right.id}:${right.os}/${right.arch}`));
writeFileSync(output, `${JSON.stringify({ supportedTargets, binaries }, null, 2)}\n`);
