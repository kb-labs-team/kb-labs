#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const [candidateArgument, originArgument] = process.argv.slice(2);
if (!candidateArgument || !originArgument) {
  throw new Error('usage: stage-versioned-origin-assets.mjs CANDIDATE_DIRECTORY ORIGIN_DIRECTORY');
}
const candidateDirectory = resolve(candidateArgument);
const originDirectory = resolve(originArgument);

function collectBinaryEntries(value, inheritedVersion, entries = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectBinaryEntries(item, inheritedVersion, entries);
  } else if (value && typeof value === 'object') {
    const version = typeof value.version === 'string' ? value.version : inheritedVersion;
    if (typeof value.url === 'string' && typeof version === 'string'
        && typeof value.filename === 'string') entries.push({ ...value, version });
    for (const child of Object.values(value)) collectBinaryEntries(child, version, entries);
  }
  return entries;
}

function inside(root, path) {
  return path !== root && path.startsWith(`${root}${sep}`);
}

function safeSegment(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(value)) {
    throw new Error(`unsafe ${label} in versioned binary index entry`);
  }
  return value;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function maybeStat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertSafeDirectoryChain(root, directory, create = false) {
  const rootStat = maybeStat(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`owned staging root is not a real directory: ${root}`);
  }
  if (!inside(root, directory) && directory !== root) throw new Error('origin path escapes its directory');
  const parts = relative(root, directory).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) {
      if (create) mkdirSync(current);
      else continue;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`origin route traverses a non-directory or symlink: ${relative(root, current)}`);
    }
  }
}

function writeOwnership(paths) {
  const temporary = `${ownershipPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(paths, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, ownershipPath);
}

const indexes = readdirSync(candidateDirectory)
  .filter(filename => /^release-index(?:-[A-Za-z0-9._-]+)?\.json$/.test(filename))
  .map(filename => JSON.parse(readFileSync(join(candidateDirectory, filename), 'utf8')));
const ownershipPath = join(dirname(originDirectory), 'versioned-origin-assets.json');
const ownershipStat = maybeStat(ownershipPath);
if (ownershipStat && (!ownershipStat.isFile() || ownershipStat.isSymbolicLink())) {
  throw new Error('versioned origin ownership record must be a regular file');
}
const previouslyOwned = existsSync(ownershipPath)
  ? JSON.parse(readFileSync(ownershipPath, 'utf8'))
  : [];
if (!Array.isArray(previouslyOwned)) throw new Error('versioned origin ownership record is invalid');
const previousPaths = new Set();
for (const ownedPath of previouslyOwned) {
  if (typeof ownedPath !== 'string') throw new Error('versioned origin ownership record is invalid');
  const segments = ownedPath.split('/');
  if (segments.length !== 2 || segments.some(segment => !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(segment))) {
    throw new Error(`unsafe path in versioned origin ownership record: ${ownedPath}`);
  }
  const path = resolve(originDirectory, ...segments);
  if (!inside(originDirectory, path)) throw new Error('versioned origin ownership path escapes its directory');
  assertSafeDirectoryChain(originDirectory, dirname(path));
  if (existsSync(path) && !lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) {
    throw new Error(`owned versioned origin route is not a file: ${ownedPath}`);
  }
  previousPaths.add(ownedPath);
}
const destinations = new Map();
for (const entry of indexes.flatMap(index => collectBinaryEntries(index, undefined))) {
  const version = safeSegment(entry.version, 'version');
  const filename = safeSegment(entry.filename, 'filename');
  if (basename(filename) !== filename) throw new Error(`unsafe binary filename in release index: ${filename}`);
  const url = new URL(entry.url);
  const urlSegments = decodeURIComponent(url.pathname).split('/').filter(Boolean);
  const corruptIndex = urlSegments.indexOf('checksum-corrupt');
  const binaryIndex = urlSegments.lastIndexOf('binaries');
  let sourceRelative;
  let routeVersion;
  if (corruptIndex >= 0) {
    routeVersion = safeSegment(urlSegments[corruptIndex + 1], 'corrupt route version');
    if (routeVersion !== `${version}-bad-checksum`
        || urlSegments[corruptIndex + 2] !== filename) {
      throw new Error(`corrupt binary URL does not have an isolated resolver route: ${entry.url}`);
    }
    sourceRelative = join('checksum-corrupt', routeVersion, filename);
  } else {
    if (binaryIndex < 0 || urlSegments[binaryIndex + 1] !== version
        || urlSegments[binaryIndex + 2] !== filename
        || binaryIndex + 3 !== urlSegments.length) continue;
    routeVersion = version;
    sourceRelative = join('binaries', version, filename);
  }
  const source = resolve(candidateDirectory, sourceRelative);
  const destination = resolve(originDirectory, routeVersion, filename);
  if (!inside(candidateDirectory, source) || !inside(originDirectory, destination)) {
    throw new Error('versioned binary staging path escapes its owned directory');
  }
  assertSafeDirectoryChain(candidateDirectory, dirname(source));
  const sourceStat = maybeStat(source);
  if (!sourceStat || !sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`versioned binary is not a regular staged file: ${sourceRelative}`);
  }
  if (!existsSync(source)) throw new Error(`versioned binary is missing from candidate staging: ${sourceRelative}`);
  const sourceDigest = sha256(source);
  const destinationKey = relative(originDirectory, destination);
  const previous = destinations.get(destinationKey);
  if (previous && previous.digest !== sourceDigest) {
    throw new Error(`versioned binary origin route collides with different content: ${destinationKey}`);
  }
  if (!previous) {
    assertSafeDirectoryChain(originDirectory, dirname(destination));
    if (maybeStat(destination) && !previousPaths.has(destinationKey)) {
      throw new Error(`versioned binary origin route already exists and is not owned by this fixture: ${destinationKey}`);
    }
    destinations.set(destinationKey, { source, digest: sourceDigest });
  }
}
const newPaths = [...destinations.keys()].sort();
writeOwnership([...new Set([...previousPaths, ...newPaths])].sort());
for (const ownedPath of previousPaths) {
  const destination = resolve(originDirectory, ...ownedPath.split('/'));
  assertSafeDirectoryChain(originDirectory, dirname(destination));
  if (maybeStat(destination)) unlinkSync(destination);
}
for (const [ownedPath, { source, digest: expectedDigest }] of destinations) {
  const destination = resolve(originDirectory, ...ownedPath.split('/'));
  if (sha256(source) !== expectedDigest) throw new Error(`versioned binary changed while staging: ${ownedPath}`);
  assertSafeDirectoryChain(originDirectory, dirname(destination), true);
  copyFileSync(source, destination);
}
writeOwnership(newPaths);
process.stdout.write(`Staged ${destinations.size} versioned binary routes in ${originDirectory}\n`);
