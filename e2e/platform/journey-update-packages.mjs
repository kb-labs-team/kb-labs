import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import registryManifest from './registry-manifest.json' with { type: 'json' };
import { invokePackageProvenanceOwner } from 'kb-create/scripts/package-provenance.mjs';
import { fileURLToPath } from 'node:url';
import { releaseArtifactPackageNames, shippedPlatformPackageSet } from 'kb-create/scripts/platform-release-config.mjs';
import { readPackedPackageManifests } from './release-index-package-stage.mjs';

export function deriveCandidateVersion(baseVersion, packagesDir, releaseManifest, digestTool, platformMembers) {
  const artifacts = readPackedPackageManifests(packagesDir);
  const packageManifests = new Map(artifacts.map(({ packageJSON }) => [packageJSON.name, packageJSON]));
  const wanted = shippedPlatformPackageSet(
    releaseArtifactPackageNames(releaseManifest, platformMembers),
    packageManifests,
  );
  const packages = [];
  for (const { filename, packageJSON } of artifacts) {
    if (wanted.has(packageJSON.name)) {
      packages.push({ name: packageJSON.name, version: packageJSON.version, tarball: filename });
      wanted.delete(packageJSON.name);
    }
  }
  if (wanted.size > 0) throw new Error(`candidate packages are missing from the packed set: ${[...wanted].join(', ')}`);
  const digest = invokePackageProvenanceOwner(digestTool,
    ['digest', 'package-set', resolve(packagesDir)], JSON.stringify(packages)).digest.slice(0, 12);
  return `${baseVersion}-cand.${digest}`;
}

// Build a release artifact set for a journey-only platform version from an existing
// stage: every selected release artifact is reused unchanged except its
// package version, which advances to the requested update version. The target
// holds the same manifest.json the
// release-index preparer reads; generated tarballs are also written to
// publishDir so the local registry can serve them.
export function prepareJourneyUpdatePackages(packagesDir, updatePackagesDir, updateVersion,
  { publishDir, failingServicePackage, requiredConfigPackage, requiredConfig, digestTool,
    registryManifest: releaseManifest = registryManifest, platformMembers } = {}) {
  if (!digestTool) throw new Error('kb-create-release-index owner is required');
  const sourceDir = resolve(packagesDir);
  const packedArtifacts = readPackedPackageManifests(sourceDir);
  const packageManifests = new Map(packedArtifacts.map(({ packageJSON }) => [packageJSON.name, packageJSON]));
  const versionedPackages = shippedPlatformPackageSet(
    releaseArtifactPackageNames(releaseManifest, platformMembers),
    packageManifests,
  );
  if (requiredConfig && !versionedPackages.has(requiredConfigPackage)) {
    throw new Error(`staged requirement package is absent from the release manifest: ${requiredConfigPackage}`);
  }
  const targetDir = resolve(updatePackagesDir);
  const registryDir = resolve(publishDir ?? packagesDir);
  const manifest = [];
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  const originals = new Map();
  const generatedFiles = [];
  for (const { filename, artifactPath: source, packageJSON } of packedArtifacts) {
    if (versionedPackages.has(packageJSON.name)
        && packageJSON.name !== failingServicePackage
        && !(packageJSON.name === requiredConfigPackage && requiredConfig)) {
      originals.set(packageJSON.name, { source, filename, packageJSON });
    } else if (packageJSON.name === failingServicePackage) {
      const unpacked = mkdtempSync('/tmp/kb-e2e-update-package-');
      try {
        execFileSync('tar', ['-xzf', source, '-C', unpacked]);
        const packageRoot = join(unpacked, 'package');
        const packageJSONPath = join(packageRoot, 'package.json');
        const packageManifest = JSON.parse(readFileSync(packageJSONPath, 'utf8'));
        packageManifest.version = updateVersion;
        writeFileSync(packageJSONPath, `${JSON.stringify(packageManifest, null, 2)}\n`);
        writeFileSync(join(packageRoot, 'dist/bin.js'),
          '#!/usr/bin/env node\nprocess.stderr.write("journey health-failure fixture\\n");\nprocess.exit(1);\n');
        const filename = filenameFor(packageJSON.name, updateVersion);
        const updateTarball = join(targetDir, filename);
        execFileSync('tar', ['-czf', updateTarball, '-C', unpacked, 'package']);
        copyFileSync(updateTarball, join(registryDir, filename));
        manifest.push({ name: packageJSON.name, version: updateVersion, tarball: filename,
          sha256: sha256(updateTarball, digestTool) });
        generatedFiles.push(filename);
      } finally {
        rmSync(unpacked, { recursive: true, force: true });
      }
    } else if (packageJSON.name === requiredConfigPackage && requiredConfig) {
      const unpacked = mkdtempSync('/tmp/kb-e2e-update-package-');
      try {
        execFileSync('tar', ['-xzf', source, '-C', unpacked]);
        const packageRoot = join(unpacked, 'package');
        const packageJSONPath = join(packageRoot, 'package.json');
        const changedPackageJSON = JSON.parse(readFileSync(packageJSONPath, 'utf8'));
        changedPackageJSON.version = updateVersion;
        writeFileSync(packageJSONPath, `${JSON.stringify(changedPackageJSON, null, 2)}\n`);
        const requirementPath = join(packageRoot, 'kb-create.requirements.json');
        const requirements = existsSync(requirementPath)
          ? JSON.parse(readFileSync(requirementPath, 'utf8'))
          : { schema: 'kb.create.requirements/v1', requirements: [] };
        requirements.requirements.push(requiredConfig);
        writeFileSync(requirementPath, `${JSON.stringify(requirements, null, 2)}\n`);
        const filename = filenameFor(packageJSON.name, updateVersion);
        const updateTarball = join(targetDir, filename);
        execFileSync('tar', ['-czf', updateTarball, '-C', unpacked, 'package']);
        copyFileSync(updateTarball, join(registryDir, filename));
        manifest.push({ name: packageJSON.name, version: updateVersion, tarball: filename,
          sha256: sha256(updateTarball, digestTool) });
        generatedFiles.push(filename);
      } finally {
        rmSync(unpacked, { recursive: true, force: true });
      }
    } else {
      copyFileSync(source, join(targetDir, filename));
      manifest.push({ name: packageJSON.name, version: packageJSON.version, tarball: filename,
        sha256: sha256(source, digestTool) });
    }
  }

  for (const packageName of versionedPackages) {
    if (packageName === failingServicePackage || (packageName === requiredConfigPackage && requiredConfig)) continue;
    const original = originals.get(packageName);
    if (!original) throw new Error(`journey update package is not packed: ${packageName}`);
    const unpacked = mkdtempSync('/tmp/kb-e2e-update-package-');
    try {
      execFileSync('tar', ['-xzf', original.source, '-C', unpacked]);
      const packageJSONPath = join(unpacked, 'package', 'package.json');
      const packageManifest = JSON.parse(readFileSync(packageJSONPath, 'utf8'));
      packageManifest.version = updateVersion;
      writeFileSync(packageJSONPath, `${JSON.stringify(packageManifest, null, 2)}\n`);
      const filename = basename(original.filename).replace(`-${original.packageJSON.version}.tgz`, `-${updateVersion}.tgz`);
      const updateTarball = join(targetDir, filename);
      execFileSync('tar', ['-czf', updateTarball, '-C', unpacked, 'package']);
      copyFileSync(updateTarball, join(registryDir, filename));
      manifest.push({ name: packageName, version: updateVersion, tarball: filename,
        sha256: sha256(updateTarball, digestTool) });
      generatedFiles.push(filename);
    } finally {
      rmSync(unpacked, { recursive: true, force: true });
    }
  }
  writeFileSync(join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(targetDir, 'generated-packages.txt'), `${generatedFiles.join('\n')}\n`);
  return targetDir;
}

function filenameFor(name, version) {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}


function sha256(path, digestTool) {
  return invokePackageProvenanceOwner(digestTool, ['digest', 'sha256', path]).digest;
}

const value = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseVersion = value('--base-version');
  const packagesDir = value('--packages-dir');
  const digestTool = value('--digest-tool');
  const membersArgument = value('--platform-members');
  if (!baseVersion || !packagesDir || !digestTool || !membersArgument) throw new Error('usage: journey-update-packages.mjs --base-version <version> --packages-dir <dir> --digest-tool <kb-create-release-index> --platform-members <comma-separated-package-names>');
  process.stdout.write(`${deriveCandidateVersion(baseVersion, packagesDir, registryManifest, digestTool, membersArgument.split(',').filter(Boolean))}\n`);
}
