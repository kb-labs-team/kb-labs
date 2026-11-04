import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export interface CandidateProvenance {
  schema: 'kb.release-provenance/1';
  candidateId: string;
  commit: string;
  flow: string;
  version: string;
  channel: string;
  workflowRunId: string;
  bundleDigest: string;
}

export interface CandidateBundleInput {
  candidateId: string;
  commit: string;
  flow: string;
  version: string;
  channel: string;
  workflowRunId: string;
  artifactsDir: string;
  outputDir: string;
  releaseIndexPath?: string;
  binaryManifestPath?: string;
  binariesDir?: string;
}

export interface CandidateArtifact {
  name: string;
  version: string;
  tarball: string;
  sha256: string;
}

export interface VerifiedCandidateBundle {
  bundleDir: string;
  artifactsDir: string;
  provenance: CandidateProvenance;
  artifacts: CandidateArtifact[];
}

export interface CandidateTrustAnchor {
  expectedDigest: string;
  candidateId: string;
  commit: string;
  flow: string;
  version: string;
}

export class CandidateBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandidateBundleError';
  }
}

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson<T>(path: string, label: string): T {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    throw new CandidateBundleError(`Candidate bundle is missing ${label}`);
  }
  try {
    return JSON.parse(source) as T;
  } catch {
    throw new CandidateBundleError(`Candidate bundle has invalid JSON in ${label}`);
  }
}

function filesUnder(directory: string, root = directory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path, root);
    if (!entry.isFile()) throw new CandidateBundleError(`Candidate bundle contains a non-file entry: ${relative(root, path)}`);
    return [relative(root, path).split(sep).join('/')];
  }).sort();
}

function copyFileWithMode(source: string, target: string): void {
  copyFileSync(source, target);
  chmodSync(target, statSync(source).mode & 0o777);
}

function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      copyFileWithMode(from, to);
    } else {
      throw new CandidateBundleError(`Candidate source contains a non-file entry: ${relative(source, from)}`);
    }
  }
}

function payloadDigest(bundleDir: string): string {
  const payload = filesUnder(bundleDir)
    .filter(path => path !== 'provenance.json' && path !== 'bundle.sha256' && path !== 'bundle.modes')
    .map(path => {
      const filePath = join(bundleDir, path);
      const mode = (lstatSync(filePath).mode & 0o777).toString(8);
      return `${path}\0${mode}\0${digest(readFileSync(filePath))}\n`;
    })
    .join('');
  return digest(payload);
}

function writeBundleIndexes(bundleDir: string): void {
  const paths = filesUnder(bundleDir).filter(path => path !== 'bundle.sha256');
  const modes = paths.map(path => {
    const mode = (lstatSync(join(bundleDir, path)).mode & 0o777).toString(8);
    return `${mode}  ./${path}\n`;
  }).join('');
  writeFileSync(join(bundleDir, 'bundle.modes'), modes);
  chmodSync(join(bundleDir, 'bundle.modes'), 0o644);

  const files = filesUnder(bundleDir).filter(path => path !== 'bundle.sha256');
  const checksums = files.map(path => `${digest(readFileSync(join(bundleDir, path)))}  ./${path}\n`).join('');
  writeFileSync(join(bundleDir, 'bundle.sha256'), checksums);
  chmodSync(join(bundleDir, 'bundle.sha256'), 0o644);
}

export function createCandidateBundle(input: CandidateBundleInput): CandidateProvenance {
  const bundleDir = resolve(input.outputDir);
  mkdirSync(bundleDir, { recursive: true });
  if (readdirSync(bundleDir).length > 0) {
    throw new CandidateBundleError(`Candidate output directory is not empty: ${bundleDir}`);
  }

  const artifactsDir = resolve(input.artifactsDir);
  copyTree(artifactsDir, join(bundleDir, 'npm'));

  if (input.flow === 'platform' && !input.releaseIndexPath) {
    throw new CandidateBundleError('Platform candidate bundle requires release-index.json');
  }
  if (input.releaseIndexPath) copyFileWithMode(input.releaseIndexPath, join(bundleDir, 'release-index.json'));
  if (input.binaryManifestPath) copyFileWithMode(input.binaryManifestPath, join(bundleDir, 'binary-manifest.json'));
  if (input.binariesDir) copyTree(input.binariesDir, join(bundleDir, 'binaries'));

  const provenance: Omit<CandidateProvenance, 'bundleDigest'> = {
    schema: 'kb.release-provenance/1',
    candidateId: input.candidateId,
    commit: input.commit,
    flow: input.flow,
    version: input.version,
    channel: input.channel,
    workflowRunId: input.workflowRunId,
  };
  writeFileSync(join(bundleDir, 'provenance.json'), `${JSON.stringify({ ...provenance, bundleDigest: '' }, null, 2)}\n`);
  const completeProvenance: CandidateProvenance = { ...provenance, bundleDigest: payloadDigest(bundleDir) };
  writeFileSync(join(bundleDir, 'provenance.json'), `${JSON.stringify(completeProvenance, null, 2)}\n`);
  writeBundleIndexes(bundleDir);
  verifyCandidateBundle(bundleDir, {
    expectedDigest: completeProvenance.bundleDigest,
    candidateId: input.candidateId,
    commit: input.commit,
    flow: input.flow,
    version: input.version,
  });
  return completeProvenance;
}

function parseIndexedPaths(bundleDir: string, filename: 'bundle.sha256' | 'bundle.modes'): Map<string, string> {
  const path = join(bundleDir, filename);
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    throw new CandidateBundleError(`Candidate bundle is missing ${filename}`);
  }
  const lines = contents.split(/\r?\n/).filter(Boolean);
  const entries = new Map<string, string>();
  for (const line of lines) {
    const match = filename === 'bundle.sha256'
      ? /^([a-f0-9]{64})  (.+)$/.exec(line)
      : /^([0-7]{3,4})  (.+)$/.exec(line);
    if (!match) throw new CandidateBundleError(`${filename} contains an invalid entry`);
    const indexedPath = match[2]!.startsWith('./') ? match[2]!.slice(2) : match[2]!;
    const resolved = resolve(bundleDir, indexedPath);
    if (resolved === bundleDir || !resolved.startsWith(`${bundleDir}${sep}`) || indexedPath.startsWith('/')) {
      throw new CandidateBundleError(`${filename} contains a path outside the candidate bundle: ${indexedPath}`);
    }
    if (entries.has(indexedPath)) throw new CandidateBundleError(`${filename} contains a duplicate path: ${indexedPath}`);
    entries.set(indexedPath, match[1]!);
  }
  return entries;
}

function verifyNpmArtifacts(artifactsDir: string): CandidateArtifact[] {
  const manifestPath = join(artifactsDir, 'manifest.json');
  const manifest = readJson<CandidateArtifact[]>(manifestPath, 'npm/manifest.json');
  if (!Array.isArray(manifest) || manifest.length === 0) throw new CandidateBundleError('Candidate npm manifest contains no artifacts');
  const names = new Set<string>();
  const paths = new Set(['manifest.json']);
  for (const artifact of manifest) {
    if (!artifact.name || !artifact.version || !artifact.tarball || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new CandidateBundleError('Candidate npm manifest contains an incomplete artifact entry');
    }
    if (!/^[a-z0-9][a-z0-9._-]*-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\.tgz$/.test(artifact.tarball)) {
      throw new CandidateBundleError(`Candidate bundle has an invalid npm tarball filename: ${artifact.tarball}`);
    }
    if (names.has(artifact.name)) throw new CandidateBundleError(`Candidate npm manifest repeats package ${artifact.name}`);
    names.add(artifact.name);
    const tarballPath = resolve(artifactsDir, artifact.tarball);
    if (tarballPath === artifactsDir || !tarballPath.startsWith(`${artifactsDir}${sep}`) || artifact.tarball.startsWith('/')) {
      throw new CandidateBundleError(`Candidate npm manifest contains a tarball path outside npm/: ${artifact.tarball}`);
    }
    const relativeTarball = relative(artifactsDir, tarballPath).split(sep).join('/');
    if (paths.has(relativeTarball)) throw new CandidateBundleError(`Candidate npm manifest repeats tarball ${artifact.tarball}`);
    paths.add(relativeTarball);
    if (!existsSync(tarballPath)) throw new CandidateBundleError(`Candidate npm manifest names a missing tarball: ${artifact.name}@${artifact.version}`);
    if (digest(readFileSync(tarballPath)) !== artifact.sha256) {
      throw new CandidateBundleError(`Candidate tarball digest differs from npm/manifest.json: ${artifact.name}@${artifact.version}`);
    }
  }
  const actual = filesUnder(artifactsDir).sort();
  const expected = [...paths].sort();
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new CandidateBundleError('Candidate npm file set differs from npm/manifest.json');
  }
  return manifest;
}

export function verifyCandidateBundle(bundlePath: string, trust: CandidateTrustAnchor): VerifiedCandidateBundle {
  const bundleDir = resolve(bundlePath);
  try {
    if (!statSync(bundleDir).isDirectory()) throw new CandidateBundleError(`Candidate bundle path is not a directory: ${bundleDir}`);
  } catch (error) {
    if (error instanceof CandidateBundleError) throw error;
    throw new CandidateBundleError(`Candidate bundle directory does not exist or cannot be read: ${bundleDir}`);
  }
  const provenance = readJson<CandidateProvenance>(join(bundleDir, 'provenance.json'), 'provenance.json');
  if (provenance.schema !== 'kb.release-provenance/1' || !provenance.candidateId || !/^[a-f0-9]{40}$/i.test(provenance.commit ?? '')
    || !provenance.flow || !provenance.version || !provenance.channel || !provenance.workflowRunId) {
    throw new CandidateBundleError('Candidate provenance is incomplete or unsupported');
  }
  if (!/^[a-f0-9]{64}$/.test(trust.expectedDigest)) {
    throw new CandidateBundleError('The trusted candidate digest must be a SHA-256 hex digest');
  }
  if (provenance.candidateId !== trust.candidateId || provenance.commit.toLowerCase() !== trust.commit.toLowerCase()
    || provenance.flow !== trust.flow || provenance.version !== trust.version) {
    throw new CandidateBundleError('Candidate provenance does not match the trusted candidate identity');
  }

  const checksumIndex = parseIndexedPaths(bundleDir, 'bundle.sha256');
  const modeIndex = parseIndexedPaths(bundleDir, 'bundle.modes');
  const artifactsDir = join(bundleDir, 'npm');
  const artifacts = verifyNpmArtifacts(artifactsDir);
  const actualFiles = filesUnder(bundleDir).filter(path => path !== 'bundle.sha256').sort();
  const checksumFiles = [...checksumIndex.keys()].sort();
  const modeFiles = [...modeIndex.keys()].sort();
  const actualModeFiles = actualFiles.filter(path => path !== 'bundle.modes');
  if (actualFiles.length !== checksumFiles.length || actualFiles.some((path, index) => path !== checksumFiles[index])) {
    throw new CandidateBundleError('Candidate file set differs from bundle.sha256');
  }
  if (actualModeFiles.length !== modeFiles.length || actualModeFiles.some((path, index) => path !== modeFiles[index])) {
    throw new CandidateBundleError('Candidate file set differs from bundle.modes');
  }
  for (const path of actualFiles) {
    const filePath = join(bundleDir, path);
    if (digest(readFileSync(filePath)) !== checksumIndex.get(path)) {
      throw new CandidateBundleError(`Candidate bundle digest mismatch at ${path}`);
    }
    if (path !== 'bundle.modes') {
      const mode = (lstatSync(filePath).mode & 0o777).toString(8);
      if (mode !== modeIndex.get(path)) throw new CandidateBundleError(`Candidate file mode differs from bundle.modes at ${path}`);
    }
  }
  for (const indexFile of ['bundle.sha256', 'bundle.modes']) {
    if ((lstatSync(join(bundleDir, indexFile)).mode & 0o777) !== 0o644) {
      throw new CandidateBundleError(`Candidate control index ${indexFile} does not have its canonical mode 0644`);
    }
  }
  if (payloadDigest(bundleDir) !== provenance.bundleDigest) {
    throw new CandidateBundleError('Candidate payload digest differs from provenance.json');
  }
  if (provenance.bundleDigest !== trust.expectedDigest) {
    throw new CandidateBundleError('Candidate payload digest differs from the trusted candidate digest');
  }
  if (provenance.flow === 'platform') {
    const index = readJson<{ platforms?: Array<{ id: string; version: string }> }>(join(bundleDir, 'release-index.json'), 'release-index.json');
    const platform = index.platforms?.find(entry => entry.id === 'platform');
    if (!platform || platform.version !== provenance.version) {
      throw new CandidateBundleError('Candidate release-index.json platform version differs from provenance.json');
    }
  }
  return { bundleDir, artifactsDir, provenance, artifacts };
}
