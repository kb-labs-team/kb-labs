/**
 * marketplace:registry command - List all REST API plugin manifests
 */

import { defineSystemCommand } from '@kb-labs/shared-command-kit';
import { generateExamples } from '../../../utils/generate-examples';
import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Very small repo root detector: looks for .git upwards. */
function detectRepoRoot(start = process.cwd()): string {
  let cur = path.resolve(start);
  while (true) {
    if (existsSync(path.join(cur, '.git'))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return start;
    } // fallback
    cur = parent;
  }
}
import { parse as parseYaml } from 'yaml';
import { glob } from 'glob';
import { getContextCwd } from '@kb-labs/shared-cli-ui';

interface PluginManifestWithPath {
  manifest: ManifestV3;
  manifestPath: string;
  pluginRoot: string;
}

type PluginsRegistryResult = {
  manifests: ManifestV3[];
  manifestsWithPaths: PluginManifestWithPath[];
  total: number;
  plugins?: PluginManifestWithPath[];
};

/**
 * Find REST API manifest path in a package
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
async function findRestApiManifestPath(pkgRoot: string, pkg: Record<string, unknown>): Promise<string | null> {
  const kbLabs = pkg.kbLabs as Record<string, unknown> | undefined;
  const kb = pkg.kb as Record<string, unknown> | undefined;

  // Check package.json.kbLabs.manifest
  if (typeof kbLabs?.manifest === 'string') {
    const manifestPath = path.isAbsolute(kbLabs.manifest)
      ? kbLabs.manifest
      : path.join(pkgRoot, kbLabs.manifest);
    try {
      await fs.access(manifestPath);
      return manifestPath;
    } catch {
      return null;
    }
  }

  // Check package.json.kb.manifest (alternative format)
  if (typeof kb?.manifest === 'string') {
    const manifestPath = path.isAbsolute(kb.manifest)
      ? kb.manifest
      : path.join(pkgRoot, kb.manifest);
    try {
      await fs.access(manifestPath);
      return manifestPath;
    } catch {
      return null;
    }
  }

  // Check package.json.kbLabs.plugins array
  if (Array.isArray(kbLabs?.plugins)) {
    for (const pluginPath of kbLabs.plugins as string[]) {
      const manifestPath = path.isAbsolute(pluginPath)
        ? pluginPath
        : path.join(pkgRoot, pluginPath);
      try {
        await fs.access(manifestPath);
        return manifestPath;
      } catch {
        continue;
      }
    }
  }

  // Check package.json.kb.plugins array (alternative format)
  if (Array.isArray(kb?.plugins)) {
    for (const pluginPath of kb.plugins as string[]) {
      const manifestPath = path.isAbsolute(pluginPath)
        ? pluginPath
        : path.join(pkgRoot, pluginPath);
      try {
        await fs.access(manifestPath);
        return manifestPath;
      } catch {
        continue;
      }
    }
  }

  // Check .kblabs/plugins/ directory
  const pluginsDir = path.join(pkgRoot, '.kblabs', 'plugins');
  try {
    const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        return path.join(pluginsDir, entry.name);
      }
    }
  } catch {
    // .kblabs/plugins/ doesn't exist
  }

  // Check conventional paths: dist/manifest.v2.js, dist/manifest.v2.ts
  const conventionalPaths = [
    path.join(pkgRoot, 'dist', 'manifest.v2.js'),
    path.join(pkgRoot, 'dist', 'manifest.v2.ts'),
    path.join(pkgRoot, 'src', 'manifest.v2.ts'),
    path.join(pkgRoot, 'manifest.v2.ts'),
    path.join(pkgRoot, 'manifest.v2.js'),
  ];

  for (const manifestPath of conventionalPaths) {
    try {
      await fs.access(manifestPath);
      return manifestPath;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Discover REST API plugins from workspace
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
async function discoverRestApiPlugins(repoRoot: string): Promise<PluginManifestWithPath[]> {
  const results: PluginManifestWithPath[] = [];
  
  // Read pnpm-workspace.yaml
  const workspaceYaml = path.join(repoRoot, 'pnpm-workspace.yaml');
  let workspacePatterns: string[] = [];
  
  try {
    const content = await fs.readFile(workspaceYaml, 'utf8');
    const parsed = parseYaml(content) as { packages?: string[] };
    workspacePatterns = parsed.packages || [];
  } catch {
    // No workspace, try to discover from current directory
    workspacePatterns = ['packages/*', 'apps/*'];
  }

  // If no patterns found, try parent directories
  if (workspacePatterns.length === 0) {
    let currentDir = repoRoot;
    for (let i = 0; i < 3; i++) {
      const parentYaml = path.join(path.dirname(currentDir), 'pnpm-workspace.yaml');
      try {
        const content = await fs.readFile(parentYaml, 'utf8');
        const parsed = parseYaml(content) as { packages?: string[] };
        if (parsed.packages && parsed.packages.length > 0) {
          workspacePatterns = parsed.packages;
          repoRoot = path.dirname(currentDir);
          break;
        }
      } catch {
        // Continue searching
      }
      currentDir = path.dirname(currentDir);
      if (currentDir === path.dirname(currentDir)) {
        break; // Reached root
      }
    }
  }

  // Find all package.json files matching workspace patterns
  const packageJsonPaths: string[] = [];
  
  for (const pattern of workspacePatterns) {
    const pkgPattern = pattern.endsWith('/package.json')
      ? pattern
      : pattern.endsWith('/*')
      ? `${pattern}/package.json`
      : `${pattern}/**/package.json`;
    
    try {
      const matches = await glob(pkgPattern, {
        cwd: repoRoot,
        absolute: true,
        ignore: ['**/node_modules/**', '**/.kb/**'],
      });
      packageJsonPaths.push(...matches);
    } catch {
      // Pattern doesn't match, continue
    }
  }

  // Deduplicate package.json paths
  const uniquePaths = Array.from(new Set(packageJsonPaths));

  // Load manifests from each package
  for (const pkgJsonPath of uniquePaths) {
    const pkgRoot = path.dirname(pkgJsonPath);
    
    try {
      const pkgContent = await fs.readFile(pkgJsonPath, 'utf8');
      const pkg = JSON.parse(pkgContent);
      
      // Find manifest path
      const manifestPath = await findRestApiManifestPath(pkgRoot, pkg);
      if (!manifestPath) {
        continue;
      }

      // Load manifest
      try {
        const module = await import(manifestPath);
        const manifest: unknown = module.manifest;
        
        // Check if it's ManifestV3 with rest.routes
        if (
          manifest &&
          typeof manifest === 'object' &&
          'schema' in manifest &&
          manifest.schema === 'kb.plugin/2' &&
          'rest' in manifest &&
          manifest.rest &&
          typeof manifest.rest === 'object' &&
          'routes' in manifest.rest &&
          Array.isArray(manifest.rest.routes) &&
          manifest.rest.routes.length > 0
        ) {
          const v3Manifest = manifest as ManifestV3;
          results.push({
            manifest: v3Manifest,
            manifestPath: path.resolve(manifestPath),
            pluginRoot: pkgRoot,
          });
        }
      } catch (_e) {
        // Failed to load manifest, skip
        continue;
      }
    } catch {
      // Failed to read package.json, skip
      continue;
    }
  }

  return results;
}

type PluginsRegistryFlags = {
  json: { type: 'boolean'; description?: string };
};

export const pluginsRegistry = defineSystemCommand<PluginsRegistryFlags, PluginsRegistryResult>({
  name: 'registry',
  scope: 'project',
  jsonTest: { safeArgs: [] },
  description: 'List all REST API plugin manifests for REST API server',
  category: 'marketplace',
  examples: generateExamples('registry', 'marketplace', [
    { flags: {} },
    { flags: { json: true } },
  ]),
  flags: {
    json: { type: 'boolean', description: 'Output in JSON format' },
  },
  analytics: {
    command: 'marketplace:registry',
    startEvent: 'MARKETPLACE_REGISTRY_STARTED',
    finishEvent: 'MARKETPLACE_REGISTRY_FINISHED',
  },
  async handler(ctx, argv, flags) {
    const cwd = getContextCwd(ctx);
    const repoRoot = detectRepoRoot(cwd);


    // Discover REST API plugins from workspace
    const restApiPlugins = await discoverRestApiPlugins(repoRoot);

    const manifests = restApiPlugins;
    const manifestsWithPaths = manifests.map((p) => ({
      manifest: p.manifest,
      manifestPath: p.manifestPath,
      pluginRoot: p.pluginRoot,
    }));


    ctx.platform?.logger?.info('Plugins registry scan completed', { count: manifests.length });

    if (flags.json) {
      return {
        manifests: manifests.map((p) => p.manifest),
        manifestsWithPaths,
        total: manifests.length,
      };
    }

    const sections: Array<{ header?: string; items: string[] }> = [
      {
        header: 'Summary',
        items: [
          `Found: ${manifests.length} REST API plugin(s)`,
          `Repository: ${repoRoot}`,
        ],
      },
    ];

    if (manifests.length > 0) {
      const pluginItems: string[] = [];
      for (const plugin of manifests) {
        const displayName = plugin.manifest.display?.name || plugin.manifest.id;
        const routesCount = plugin.manifest.rest?.routes?.length || 0;
        pluginItems.push(
          `${ctx.ui.symbols.success} ${plugin.manifest.id}@${plugin.manifest.version} - ${displayName}`
        );
        pluginItems.push(`  Path: ${plugin.manifestPath}`);
        pluginItems.push(`  Routes: ${routesCount}`);
      }
      sections.push({
        header: 'Plugins',
        items: pluginItems,
      });
    } else {
      sections.push({
        items: ['No REST API plugins found'],
      });
    }

    ctx.ui.info('Plugins Registry', { sections });

    return {
      manifests: manifests.map((p) => p.manifest),
      manifestsWithPaths,
      total: manifests.length,
      plugins: manifests,
    };
  },
});
