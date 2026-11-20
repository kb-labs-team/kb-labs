import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlatformReleaseConfig } from '../kb-create/scripts/platform-release-config.mjs';

const SERVICE_PACKAGE = '@kb-labs/marketplace-registry-app';
const SDK_PACKAGE = '@kb-labs/sdk';
const FORMAT = 'kb.registry-image-composition/v1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function packageJson(packagePath) {
  return JSON.parse(readFileSync(packagePath, 'utf8'));
}

function workspacePackageFiles(workspaceRoot) {
  const files = [
    path.join(workspaceRoot, 'services/marketplace-registry/app/package.json'),
    path.join(workspaceRoot, 'sdk/sdk/package.json'),
  ];
  const coreRoot = path.join(workspaceRoot, 'core');
  if (existsSync(coreRoot)) {
    for (const entry of requireDirectory(coreRoot)) {
      const packagePath = path.join(coreRoot, entry, 'package.json');
      if (existsSync(packagePath)) files.push(packagePath);
    }
  }
  const adaptersRoot = path.join(workspaceRoot, 'adapters');
  if (existsSync(adaptersRoot)) {
    for (const entry of requireDirectory(adaptersRoot)) {
      const packagePath = path.join(adaptersRoot, entry, 'package.json');
      if (existsSync(packagePath)) files.push(packagePath);
    }
  }
  return files;
}

function requireDirectory(directory) {
  // Kept behind a tiny wrapper so callers can substitute a workspace root in tests.
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

export function configuredAdapterPackageRoots(adapters, workspacePackages) {
  const names = workspacePackages instanceof Map
    ? [...workspacePackages.keys()]
    : [...workspacePackages];
  const roots = new Set();
  for (const configured of Object.values(adapters ?? {})) {
    if (typeof configured !== 'string' || configured.length === 0) {
      throw new Error('platform adapter configuration must contain package strings');
    }
    const root = names
      .filter(name => configured === name || configured.startsWith(`${name}/`))
      .sort((left, right) => right.length - left.length)[0];
    if (!root) throw new Error(`configured platform adapter ${configured} is absent from package manifests`);
    roots.add(root);
  }
  return [...roots].sort();
}

export function buildRegistryImageCompositionPlan({ workspaceRoot = ROOT, sourceRevision }) {
  if (typeof sourceRevision !== 'string' || sourceRevision.length === 0) {
    throw new Error('Registry image composition requires a source revision');
  }
  const packages = new Map();
  for (const packagePath of workspacePackageFiles(workspaceRoot)) {
    const manifest = packageJson(packagePath);
    if (typeof manifest.name === 'string') packages.set(manifest.name, { ...manifest, packageJsonPath: packagePath });
  }

  const releaseConfigPath = path.join(workspaceRoot, 'tools/kb-create/config/platform-release.jsonc');
  const releaseConfig = readPlatformReleaseConfig(releaseConfigPath);
  const adapterPackages = configuredAdapterPackageRoots(releaseConfig.adapters, packages);
  const importerPath = path.join(workspaceRoot, 'e2e/registry-image-composition/package.json');
  const importer = packageJson(importerPath);
  const expectedDependencies = [...new Set([SERVICE_PACKAGE, SDK_PACKAGE, ...adapterPackages])].sort();
  const dependencies = importer.dependencies ?? {};
  const extra = Object.keys(dependencies).filter(name => !expectedDependencies.includes(name));
  const missing = expectedDependencies.filter(name => dependencies[name] !== 'workspace:*');
  if (extra.length || missing.length) {
    throw new Error(`Registry image composition importer differs from platform config (missing or non-workspace: ${missing.join(', ') || '(none)'}; extra: ${extra.join(', ') || '(none)'})`);
  }

  const pnpmLockPath = path.join(workspaceRoot, 'pnpm-lock.yaml');
  const pnpmLockSha256 = createHash('sha256').update(readFileSync(pnpmLockPath)).digest('hex');
  const rootPackages = expectedDependencies.map(name => {
    const manifest = packages.get(name);
    if (!manifest) throw new Error(`Registry image composition package ${name} has no workspace manifest`);
    return {
      name,
      version: manifest.version,
      packageJsonPath: manifest.packageJsonPath,
      integrity: packageJsonIntegrity(manifest.packageJsonPath),
    };
  });

  return {
    schema: FORMAT,
    sourceRevision,
    pnpmLockSha256,
    adapterPackages,
    packages: rootPackages,
    workspacePackages: packages,
  };
}

export function packageJsonIntegrity(packageJsonPath) {
  return `sha256-${createHash('sha256').update(readFileSync(packageJsonPath)).digest('base64')}`;
}

function projectedPackageRoot(deploymentRoot, packageName) {
  const packageRoot = path.join(deploymentRoot, 'node_modules', ...packageName.split('/'));
  const realPackageRoot = realpathSync(packageRoot);
  const manifestPath = path.join(realPackageRoot, 'package.json');
  return { name: packageName, packageRoot, realPackageRoot, manifestPath, manifest: packageJson(manifestPath) };
}

function resolveWorkspacePackageRoot(fromPackageRoot, packageName) {
  let current = realpathSync(fromPackageRoot);
  while (true) {
    const candidate = path.join(current, 'node_modules', ...packageName.split('/'));
    if (existsSync(path.join(candidate, 'package.json'))) {
      const resolvedRoot = realpathSync(candidate);
      const manifest = packageJson(path.join(resolvedRoot, 'package.json'));
      if (manifest.name === packageName) return resolvedRoot;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`could not resolve package root for ${packageName} from ${fromPackageRoot}`);
}

function assertOnePlatformModuleGraph(deploymentRoot, initialPackages) {
  const realDeploymentRoot = realpathSync(deploymentRoot);
  const pending = initialPackages.map(({ name, realPackageRoot, manifest }) => ({
    name,
    root: realPackageRoot,
    manifest,
  }));
  const visited = new Set();
  const rootsByName = new Map();
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current.root)) continue;
    visited.add(current.root);
    const relativeRoot = path.relative(realDeploymentRoot, current.root);
    if (relativeRoot === '..' || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot)) {
      throw new Error(`Registry composition package ${current.name} resolves outside its deploy root`);
    }
    if (current.name === SDK_PACKAGE || current.name.startsWith('@kb-labs/core-')) {
      const priorRoot = rootsByName.get(current.name);
      if (priorRoot && priorRoot !== current.root) {
        throw new Error(`Registry image composition resolves multiple copies of ${current.name}`);
      }
      rootsByName.set(current.name, current.root);
    }
    const dependencies = {
      ...current.manifest.dependencies,
      ...current.manifest.optionalDependencies,
      ...current.manifest.peerDependencies,
    };
    for (const dependencyName of Object.keys(dependencies)) {
      if (!dependencyName.startsWith('@kb-labs/')) continue;
      let dependencyRoot;
      try {
        dependencyRoot = resolveWorkspacePackageRoot(current.root, dependencyName);
      } catch (error) {
        if (
          current.manifest.optionalDependencies?.[dependencyName] !== undefined ||
          current.manifest.peerDependenciesMeta?.[dependencyName]?.optional
        ) continue;
        throw new Error(`Registry composition cannot resolve ${dependencyName} from ${current.name}: ${error.message}`);
      }
      if (dependencyName === SDK_PACKAGE || dependencyName.startsWith('@kb-labs/core-')) {
        const priorRoot = rootsByName.get(dependencyName);
        if (priorRoot && priorRoot !== dependencyRoot) {
          throw new Error(`Registry image composition resolves multiple copies of ${dependencyName}`);
        }
        rootsByName.set(dependencyName, dependencyRoot);
      }
      if (!visited.has(dependencyRoot)) {
        pending.push({
          name: dependencyName,
          root: dependencyRoot,
          manifest: packageJson(path.join(dependencyRoot, 'package.json')),
        });
      }
    }
  }
}

export function createRegistryImageArtifacts({ workspaceRoot = ROOT, deploymentRoot, sourceRevision, pnpmVersion }) {
  if (!deploymentRoot) throw new Error('Registry image composition deployment root is required');
  if (typeof pnpmVersion !== 'string' || pnpmVersion.length === 0) throw new Error('Registry image composition requires the pnpm version');
  const plan = buildRegistryImageCompositionPlan({ workspaceRoot, sourceRevision });
  const deployedPackages = new Map();
  for (const expected of plan.packages) {
    const actual = projectedPackageRoot(deploymentRoot, expected.name);
    if (actual.manifest.name !== expected.name || actual.manifest.version !== expected.version) {
      throw new Error(`deployed Registry composition package ${expected.name} does not match the locked workspace manifest`);
    }
    if (packageJsonIntegrity(actual.manifestPath) !== expected.integrity) {
      throw new Error(`deployed Registry composition package ${expected.name} has a different package.json from the source revision`);
    }
    deployedPackages.set(expected.name, actual);
  }

  assertOnePlatformModuleGraph(deploymentRoot, [
    deployedPackages.get(SERVICE_PACKAGE),
    deployedPackages.get(SDK_PACKAGE),
    ...plan.adapterPackages.map(packageName => deployedPackages.get(packageName)),
  ]);

  const adapters = {};
  for (const packageName of plan.adapterPackages) {
    const deployed = deployedPackages.get(packageName);
    adapters[packageName] = {
      version: deployed.manifest.version,
      integrity: packageJsonIntegrity(deployed.manifestPath),
      resolvedPath: `./node_modules/${packageName}`,
      enabled: true,
      source: 'platform',
    };
  }
  const lock = { schema: 'kb.marketplace/3', plugins: {}, adapters };
  const manifest = {
    schema: FORMAT,
    sourceRevision: plan.sourceRevision,
    pnpmVersion,
    pnpmLockSha256: plan.pnpmLockSha256,
    packages: plan.packages.map(({ name, version, integrity }) => ({ name, version, integrity })),
    adapterPackages: plan.adapterPackages,
  };
  return { lock, manifest };
}

export async function writeRegistryImageArtifacts(options) {
  const { lock, manifest } = createRegistryImageArtifacts(options);
  const kbRoot = path.join(options.deploymentRoot, '.kb');
  await mkdir(kbRoot, { recursive: true });
  const lockPath = path.join(kbRoot, 'marketplace.lock');
  const manifestPath = path.join(kbRoot, 'image-composition.json');
  await Promise.all([
    writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`),
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
  return { lockPath, manifestPath };
}

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deploymentRoot = value('--deployment-root');
  const sourceRevision = value('--source-revision');
  const pnpmVersion = value('--pnpm-version');
  if (!deploymentRoot || !sourceRevision || !pnpmVersion) {
    process.stderr.write('usage: registry-image-composition.mjs --deployment-root <path> --source-revision <sha> --pnpm-version <version>\n');
    process.exit(2);
  }
  const artifacts = await writeRegistryImageArtifacts({ deploymentRoot, sourceRevision, pnpmVersion });
  process.stdout.write(`${JSON.stringify(artifacts)}\n`);
}
