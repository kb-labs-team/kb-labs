#!/usr/bin/env node

// Converts the exact GoReleaser checksum output into the binary part of the
// unified release-index input. It never resolves a channel or a "latest"
// release; the tag and asset bytes are explicit inputs.
import { readFileSync, writeFileSync } from 'node:fs';

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
const repository = required('--repository');
const releaseTag = required('--release-tag');
const output = required('--output');
// Author and ops tools are not part of a user installation (ADR-0045): the
// index lists only what the launcher may install. kb-dev in particular is how
// platform authors run services from the monorepo, never how a user runs one.
const AUTHOR_AND_OPS_TOOLS = new Set(['kb-dev', 'kb-devkit', 'kb-env', 'kb-deploy', 'kb-monitor']);
const entries = readFileSync(checksumsPath, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const binaries = [];
const seen = new Set();

for (const line of entries) {
  const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
  if (!match) continue;
  const [, sha256, rawFilename] = match;
  const filename = rawFilename.replace(/^\*+/, '');
  const target = filename.match(/^(kb-[a-z0-9-]+)-(darwin|linux|windows)-(amd64|arm64)(\.exe)?$/);
  if (!target) continue;
  const [, id, os, arch] = target;
  if (AUTHOR_AND_OPS_TOOLS.has(id)) continue;
  const key = `${id}:${os}/${arch}`;
  if (seen.has(key)) throw new Error(`duplicate binary asset ${key}`);
  seen.add(key);
  binaries.push({
    id,
    os,
    arch,
    filename,
    sha256: sha256.toLowerCase(),
    url: `https://github.com/${repository}/releases/download/${releaseTag}/${filename}`,
  });
}

if (binaries.length === 0) throw new Error('checksums file contains no KB Labs binary assets');
binaries.sort((left, right) => `${left.id}:${left.os}/${left.arch}`.localeCompare(`${right.id}:${right.os}/${right.arch}`));
writeFileSync(output, `${JSON.stringify({ binaries }, null, 2)}\n`);
