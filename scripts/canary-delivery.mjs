import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = data => createHash('sha256').update(data).digest('hex');
const validTag = tag => /^v[0-9]+\.[0-9]+\.[0-9]+-canary\.[A-Za-z0-9.-]+-binaries$/.test(tag);
export function retainCanaries(history, current) {
  const all = [...new Set([current, ...history])];
  return { keep: all.slice(0, 3), remove: all.slice(3) };
}
export function stageCanary(bundle, output, tag, candidateId, history) {
  if (!validTag(tag) || !history.every(validTag)) throw new Error('invalid canary version directory');
  const manifest = JSON.parse(readFileSync(join(bundle, 'binary-manifest.json')));
  const files = new Map();
  function collect(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) {
        const digest = sha(readFileSync(path));
        if (!files.has(digest)) files.set(digest, path);
      }
    }
  }
  collect(join(bundle, 'binaries'));
  if (!Array.isArray(manifest.binaries) || manifest.binaries.length === 0) throw new Error('binary manifest is empty');
  const target = join(output, tag);
  mkdirSync(target, { recursive: true });
  const sums = readFileSync(join(bundle, 'binaries', 'checksums.txt'), 'utf8');
  const lines = new Set(sums.split(/\r?\n/));
  const names = new Set();
  for (const binary of manifest.binaries) {
    if (basename(binary.filename) !== binary.filename || names.has(binary.filename)) throw new Error('invalid or duplicate binary filename');
    names.add(binary.filename);
    if (!lines.has(`${binary.sha256}  ${binary.filename}`)) throw new Error(`checksum mismatch for ${binary.filename}`);
    const source = files.get(binary.sha256);
    if (!source) throw new Error(`missing binary ${binary.filename}`);
    copyFileSync(source, join(target, binary.filename));
  }
  const index = readFileSync(join(bundle, 'release-index.json'));
  writeFileSync(join(target, 'release-index.json'), index);
  const terminatedSums = sums.endsWith('\n') ? sums : `${sums}\n`;
  writeFileSync(join(target, 'checksums.txt'), `${terminatedSums}${sha(index)}  release-index.json\n`);
  const {keep, remove} = retainCanaries(history, tag);
  mkdirSync(join(output, 'binaries-canary'), { recursive: true });
  writeFileSync(join(output, 'binaries-canary', 'channel.json'), `${JSON.stringify({schema:2,channel:'canary',tag,candidateId,indexDigest:sha(index),history:keep}, null, 2)}\n`);
  writeFileSync(join(output, 'remove.json'), JSON.stringify(remove));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [bundle, output, tag, candidateId, previous] = process.argv.slice(2);
  if (!bundle || !output || !tag || !candidateId || !previous) throw new Error('bundle, output, tag, candidate ID and previous pointer are required');
  const old = JSON.parse(readFileSync(previous, 'utf8'));
  stageCanary(bundle, output, tag, candidateId, old.history);
}
