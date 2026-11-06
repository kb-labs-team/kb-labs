import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { DiscoveredAdapter } from './discover-adapters.js';
import type { CatalogAdapter, CatalogOpenOptions } from '@kb-labs/plugin-contracts';
import type { LoadedAdapterModule } from './adapter-loader.js';
import { AdapterUnavailableError } from '@kb-labs/core-platform';

/** Create a typed startup error without misdiagnosing adapter load failures as missing installs. */
export function configuredAdapterLoadError(
  slot: string,
  modulePath: string,
  cause?: unknown,
  platformRoot?: string,
): AdapterUnavailableError {
  if (cause instanceof AdapterUnavailableError && cause.action) {
    return cause;
  }
  const packageName = modulePath.split('/').slice(0, 2).join('/');
  const causeCode = typeof cause === 'object' && cause !== null && 'code' in cause
    ? String(cause.code)
    : undefined;
  const causeMessage = cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause);
  const packageRoot = platformRoot ? path.join(platformRoot, 'node_modules', packageName) : undefined;
  const packageMissing = causeMessage !== undefined && (
    ((causeCode === 'ERR_MODULE_NOT_FOUND' || causeCode === 'MODULE_NOT_FOUND') && (
    causeMessage.includes(`Cannot find package '${modulePath}'`) ||
    causeMessage.includes(`Cannot find package '${packageName}'`) ||
    causeMessage.includes(`Cannot find module '${modulePath}'`) ||
      causeMessage.includes(`Cannot find module '${packageName}'`)
    )) ||
    (causeCode === 'ENOENT' && packageRoot !== undefined &&
      causeMessage.includes(path.join(packageRoot, 'package.json')))
  );
  const diagnosis = causeMessage
    ? ` Cause: ${causeCode ? `${causeCode}: ` : ''}${causeMessage}`
    : '';
  const command = packageMissing
    ? `kb marketplace install ${packageName} --scope platform`
    : `kb-create doctor --platform-root ${JSON.stringify(platformRoot ?? '.')}`;
  const action = {
    id: packageMissing ? 'install-adapter' : 'diagnose-adapter-load',
    label: packageMissing ? `Install ${packageName}` : 'Diagnose the installed platform',
    command,
  };
  const nextStep = packageMissing
    ? ` Install it with \`${command}\`.`
    : ` Run \`${command}\` to inspect the installed platform.`;
  return new AdapterUnavailableError(
    slot,
    'load-failed',
    `Configured adapter package "${modulePath}" could not be loaded.${nextStep}${diagnosis}`,
    cause,
    {
      userMessage: `Adapter ${slot} is unavailable because ${packageName} could not be loaded.`,
      hint: command,
      action,
    },
  );
}

/** Explain how to build a workspace adapter whose package exists but has no output yet. */
export function configuredWorkspaceAdapterNotBuiltError(
  slot: string,
  modulePath: string,
): AdapterUnavailableError {
  return new AdapterUnavailableError(
    slot,
    'load-failed',
    `Configured workspace adapter package "${modulePath}" has not been built. Run \`pnpm build\` and retry.`,
    undefined,
    {
      userMessage: `Workspace adapter package "${modulePath}" has not been built.`,
      hint: 'Build the workspace adapter packages, then retry the command.',
      action: {
        id: 'build-workspace-adapters',
        label: 'Build workspace adapters',
        command: 'pnpm build',
      },
    },
  );
}

/** Explain that a package explicitly bound as an adapter does not implement the adapter contract. */
export function configuredWorkspaceAdapterInvalidError(
  slot: string,
  packageName: string,
  detail: string,
): AdapterUnavailableError {
  return new AdapterUnavailableError(
    slot,
    'load-failed',
    `Configured workspace package "${packageName}" is not a usable adapter: ${detail}`,
    undefined,
    {
      userMessage: `Configured package "${packageName}" is not a valid adapter for platform.adapters.${slot}.`,
      hint: `Correct platform.adapters.${slot} to use a package with a KB adapter manifest implements value and a createAdapter export, then run \`node ./cli/bin/dist/bin.js qa cases validate --json\`.`,
      action: {
        id: 'validate-platform-adapter-binding',
        label: 'Validate platform adapter binding',
        command: 'node ./cli/bin/dist/bin.js qa cases validate --json',
      },
    },
  );
}

/** Load catalog declarations into runtime adapters; all executable module loading stays here. */
export async function loadCatalogAdapterEntries(
  entries: ReadonlyMap<string, CatalogAdapter>,
  options: CatalogOpenOptions['workspaceAdapters'],
): Promise<Map<string, DiscoveredAdapter>> {
  const discovered = new Map<string, DiscoveredAdapter>();
  const configured = new Map((options?.development ? options.configuredPackages : []).map(({ packageName, slot }) => [packageName, slot]));

  for (const [id, entry] of entries) {
    const slot = entry.source === 'workspace' ? configured.get(id) : undefined;
    if (entry.manifest.kind !== 'adapter') {
      if (slot) {
        if (entry.manifest.kind === 'failed' && entry.manifest.modulePath) {
          try {
            await fs.access(entry.manifest.modulePath);
          } catch {
            throw configuredWorkspaceAdapterNotBuiltError(slot, id);
          }
        }
        throw configuredWorkspaceAdapterInvalidError(slot, id, entry.manifest.reason);
      }
      continue;
    }

    let mainPath = 'dist/index.js';
    let packageName = id;
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(entry.packageRoot, 'package.json'), 'utf-8')) as { main?: string; name?: string };
      mainPath = metadata.main || mainPath;
      packageName = metadata.name || packageName;
    } catch {
      // The previous discovery boundary used the lock identity and default entry point when package metadata was absent.
    }

    const modulePath = path.join(entry.packageRoot, mainPath);
    if (entry.source === 'workspace') {
      try {
        await fs.access(modulePath);
      } catch {
        if (slot) throw configuredWorkspaceAdapterNotBuiltError(slot, id);
        continue;
      }
    }

    let loaded: Record<string, unknown>;
    try {
      loaded = await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
    } catch (error) {
      if (entry.source === 'workspace') throw error;
      continue;
    }

    if (entry.source === 'workspace' && slot && typeof loaded.createAdapter !== 'function') {
      throw configuredWorkspaceAdapterInvalidError(slot, id, 'its module does not export createAdapter');
    }
    const createAdapter = loaded.createAdapter;
    if (typeof createAdapter !== 'function') continue;

    const adapter: DiscoveredAdapter = {
      packageName,
      pkgRoot: entry.packageRoot,
      createAdapter: (config?: unknown) => createAdapter(config, {}),
      module: { ...loaded, manifest: entry.manifest.manifest },
      entrypointManifests: { '': entry.manifest.manifest },
    };
    for (const entrypoint of Object.values(entry.manifest.manifest.defaultFor ?? {})) {
      const subpath = entrypoint.join('/');
      if (!subpath || adapter.entrypointManifests[subpath]) {continue;}
      const entrypointModule = await loadDiscoveredAdapterModule(adapter, `${packageName}/${subpath}`);
      adapter.entrypointManifests[subpath] = entrypointModule.manifest;
    }
    discovered.set(id, adapter);
    discovered.set(packageName, adapter);
  }
  return discovered;
}

/** Load an adapter from its discovered package, preserving requested subpaths. */
export async function loadDiscoveredAdapterModule(
  adapter: DiscoveredAdapter,
  modulePath: string,
): Promise<LoadedAdapterModule> {
  const basePackage = modulePath.split('/').slice(0, 2).join('/');
  const subpath = modulePath.startsWith(`${basePackage}/`)
    ? modulePath.slice(basePackage.length + 1)
    : undefined;
  const filePath = subpath
    ? path.join(adapter.pkgRoot, 'dist', `${subpath}.js`)
    : path.join(adapter.pkgRoot, 'dist', 'index.js');

  await fs.access(filePath);
  const module = await import(pathToFileURL(filePath).href);
  const factory = module.createAdapter || module.default;
  const manifest = module.manifest;
  if (typeof factory !== 'function') {
    throw new Error(`${subpath ? `Subpath ${modulePath}` : `Module ${modulePath}`} has no createAdapter or default export`);
  }
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`${subpath ? `Subpath ${modulePath}` : `Module ${modulePath}`} has no manifest export`);
  }
  return { createAdapter: factory, manifest, pkgRoot: adapter.pkgRoot };
}

/** Load directly from a workspace package and give unbuilt output an actionable typed failure. */
export async function loadWorkspaceAdapterModule(
  slot: string,
  adapter: DiscoveredAdapter,
  modulePath: string,
): Promise<LoadedAdapterModule> {
  const basePackage = modulePath.split('/').slice(0, 2).join('/');
  const subpath = modulePath.startsWith(`${basePackage}/`)
    ? modulePath.slice(basePackage.length + 1)
    : undefined;
  const expectedFile = path.join(adapter.pkgRoot, 'dist', `${subpath ?? 'index'}.js`);
  try {
    await fs.access(expectedFile);
  } catch {
    throw configuredWorkspaceAdapterNotBuiltError(slot, modulePath);
  }
  return loadDiscoveredAdapterModule(adapter, modulePath);
}
