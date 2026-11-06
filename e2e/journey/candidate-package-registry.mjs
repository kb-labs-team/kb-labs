#!/usr/bin/env node

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const packagesDirectory = resolve(process.argv[2] ?? '');
const candidateDirectory = resolve(process.argv[3] ?? '');
const upstreamRegistry = process.argv[5];
if (!process.argv[2] || !process.argv[3] || !upstreamRegistry) {
  console.error('package directory, candidate directory, and cached upstream registry URL are required');
  process.exit(2);
}
let packagesByDigest;
let packagesByName;
let packagesByPath;

function packageArtifacts() {
  if (packagesByDigest) return;
  packagesByDigest = new Map();
  packagesByName = new Map();
  packagesByPath = new Map();
  for (const filename of readdirSync(packagesDirectory).filter(name => name.endsWith('.tgz'))) {
    const path = join(packagesDirectory, filename);
    const data = readFileSync(path);
    const digest = createHash('sha256').update(data).digest('hex');
    packagesByDigest.set(digest, path);
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', path, 'package/package.json'], { encoding: 'utf8' }));
    const packagePath = `/${manifest.name}/-/${manifest.name.split('/').at(-1)}-${manifest.version}.tgz`;
    const versionEntry = {
      ...manifest,
      name: manifest.name,
      version: manifest.version,
      dist: {
        tarball: packagePath,
        shasum: createHash('sha1').update(data).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(data).digest('base64')}`,
      },
    };
    const versions = packagesByName.get(manifest.name) ?? new Map();
    versions.set(manifest.version, versionEntry);
    packagesByName.set(manifest.name, versions);
    packagesByPath.set(packagePath, path);
  }
}

function releaseArtifacts(value, entries = []) {
  if (Array.isArray(value)) {
    for (const item of value) releaseArtifacts(item, entries);
  } else if (value && typeof value === 'object') {
    if (typeof value.tarball === 'string' ||
        (typeof value.url === 'string' && typeof value.filename === 'string' && typeof value.sha256 === 'string')) {
      entries.push(value);
    }
    for (const child of Object.values(value)) releaseArtifacts(child, entries);
  }
  return entries;
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, 'http://127.0.0.1');
  const requestedPath = requestUrl.pathname;
  const decodedPath = decodeURIComponent(requestedPath);
  if (request.method !== 'GET') {
    response.writeHead(404).end();
    return;
  }
  const releaseIndex = join(candidateDirectory, 'release-index.json');
  if (!existsSync(releaseIndex)) {
    response.writeHead(404).end();
    return;
  }
  const entries = releaseArtifacts(JSON.parse(readFileSync(releaseIndex, 'utf8')));
  packageArtifacts();
  const packageName = decodedPath.replace(/^\//, '');
  const versions = packagesByName.get(packageName);
  if (versions) {
    const sortedVersions = [...versions.keys()].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const latest = sortedVersions.at(-1);
    const metadata = {
      name: packageName,
      'dist-tags': { latest },
      versions: Object.fromEntries([...versions].map(([version, entry]) => [version, {
        ...entry,
        dist: { ...entry.dist, tarball: `http://127.0.0.1:${server.address().port}${entry.dist.tarball}` },
      }])),
    };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(metadata));
    return;
  }
  const packageArtifact = packagesByPath.get(decodedPath);
  if (packageArtifact) {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    createReadStream(packageArtifact).pipe(response);
    return;
  }
  const entry = entries.find(item => {
    const artifactUrl = item.tarball ?? item.url;
    return typeof artifactUrl === 'string' && new URL(artifactUrl).pathname === requestedPath;
  });
  if (!entry) {
    const upstreamUrl = new URL(requestUrl.pathname + requestUrl.search, upstreamRegistry);
    const upstream = await fetch(upstreamUrl);
    const headers = {};
    for (const name of ['content-type', 'cache-control', 'etag', 'last-modified']) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    response.writeHead(upstream.status, headers);
    if (upstream.body) {
      for await (const chunk of upstream.body) response.write(chunk);
    }
    response.end();
    return;
  }
  const artifact = !entry.tarball
    ? join(candidateDirectory, basename(requestedPath))
    : packagesByDigest.get(entry.sha256);
  if (!artifact || !existsSync(artifact)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/octet-stream' });
  createReadStream(artifact).pipe(response);
});
server.listen(Number(process.argv[4] ?? 0), '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`http://127.0.0.1:${address.port}\n`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
