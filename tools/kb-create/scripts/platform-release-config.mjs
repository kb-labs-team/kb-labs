import { readFileSync } from 'node:fs';

export const DEFAULT_PLATFORM_PACKAGE = '@kb-labs/core-runtime';
export const DEFAULT_SDK_PACKAGE = '@kb-labs/sdk';
export const DEFAULT_HOST_PACKAGE = '@kb-labs/host-app';

export function releaseArtifactPackageNames(manifest, platformMembers) {
  if (!Array.isArray(platformMembers)) throw new Error('release platform members are required');
  return [...new Set([
    ...(manifest.core ?? []).map(item => item.name),
    ...(manifest.services ?? []).map(item => item.pkg),
    ...(manifest.adapters ?? []).map(item => item.name),
    ...platformMembers,
  ].filter(Boolean))];
}

export function readPlatformReleaseConfig(path) {
  const source = readFileSync(path, 'utf8');
  const json = path.endsWith('.jsonc') ? stripJsonComments(source) : source;
  const config = JSON.parse(json);
  const flow = config.profiles?.find(profile => profile.id === 'default')?.products?.release?.flows?.platform;
  const adapters = config.platform?.adapters;
  const marketplaceSources = config.marketplace?.sources;
  if (!Array.isArray(flow?.platformMembers) || flow.platformMembers.length === 0) {
    throw new Error('release.flows.platform.platformMembers must be a non-empty array');
  }
  if (!adapters || typeof adapters !== 'object' || Array.isArray(adapters)) {
    throw new Error('platform.adapters is required for a platform release index');
  }
  if (marketplaceSources !== undefined && (!Array.isArray(marketplaceSources) || marketplaceSources.length === 0)) {
    throw new Error('marketplace.sources must be a non-empty array when declared');
  }
  const additionalRequirements = flow.platformRequires ?? [];
  if (!Array.isArray(additionalRequirements) || additionalRequirements.some(slot => typeof slot !== 'string' || slot.length === 0)) {
    throw new Error('release.flows.platform.platformRequires must be an array of adapter capability names');
  }
  return {
    platformMembers: flow.platformMembers,
    platformRequires: [...new Set([
      ...Object.keys(adapters).filter(slot => Boolean(adapters[slot])),
      ...additionalRequirements,
    ])],
    adapters,
    adapterOptions: config.platform.adapterOptions ?? {},
    marketplaceSources,
  };
}

export function configuredAdapterPackages(adapters, packages) {
  const resolved = new Set();
  for (const configuredPackage of Object.values(adapters ?? {})) {
    if (typeof configuredPackage !== 'string' || configuredPackage.length === 0) {
      throw new Error('platform adapter configuration must contain package strings');
    }
    const match = [...packages.keys()]
      .filter(name => configuredPackage === name || configuredPackage.startsWith(`${name}/`))
      .sort((left, right) => right.length - left.length)[0];
    if (!match) throw new Error(`configured platform adapter ${configuredPackage} is absent from package manifests`);
    resolved.add(match);
  }
  return [...resolved];
}

export function platformPackageRoots({
  servicePackages,
  hostPackage = DEFAULT_HOST_PACKAGE,
  platformMembers,
  adapterPackages,
  platformPackage = DEFAULT_PLATFORM_PACKAGE,
  sdkPackage = DEFAULT_SDK_PACKAGE,
}) {
  return new Set([
    ...servicePackages,
    hostPackage,
    ...platformMembers,
    ...adapterPackages,
    sdkPackage,
  ]);
}

export function platformSharedPackages(roots, pluginPackages, platformPackage) {
  return new Set([platformPackage, ...roots].filter(name => !pluginPackages.has(name)));
}

export function shippedPlatformPackageSet(roots, releaseArtifactManifests, platformPackage = DEFAULT_PLATFORM_PACKAGE) {
  const closure = new Set();
  const visit = packageName => {
    if (closure.has(packageName)) return;
    closure.add(packageName);
    const manifest = releaseArtifactManifests.get(packageName);
    if (!manifest) return;
    for (const dependency of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]) {
      if (releaseArtifactManifests.has(dependency)) visit(dependency);
    }
  };
  for (const packageName of [platformPackage, ...roots]) visit(packageName);
  return closure;
}

function stripJsonComments(source) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
    } else if (current === '"') {
      inString = true;
      output += current;
    } else if (current === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      output += '\n';
    } else if (current === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 1;
    } else {
      output += current;
    }
  }
  return output.replace(/,(\s*[}\]])/g, '$1');
}
