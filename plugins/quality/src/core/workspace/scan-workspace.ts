/**
 * Workspace package scanner for flat monorepo layout.
 *
 * Discovers all packages by scanning top-level dirs (core/, sdk/, plugins/, etc.)
 * and reading their package.json files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { defaultQualityConfig, type QualityLayerMap } from '../../contracts/index.js';

export interface WorkspacePackage {
  name: string;
  dir: string;
  packageJsonPath: string;
  /** Layer index derived from path prefix */
  layer: number;
  deps: string[];
  devDeps: string[];
}

/** Resolve layer index for a package dir relative to rootDir */
export function resolveLayer(
  pkgDir: string,
  rootDir: string,
  layerMap: QualityLayerMap = defaultQualityConfig.layers
): number {
  const rel = path.relative(rootDir, pkgDir).replace(/\\/g, '/');
  for (const [prefix, layer] of Object.entries(layerMap)) {
    if (rel.startsWith(prefix)) {
      return layer;
    }
  }
  return -1; // unknown layer — excluded from layering checks
}

/** Scan all workspace packages in a flat monorepo */
export function scanWorkspace(
  rootDir: string,
  layerMap: QualityLayerMap = defaultQualityConfig.layers
): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];

  if (!fs.existsSync(rootDir)) {return packages;}

  // Top-level dirs that can contain packages
  const topDirs = ['core', 'sdk', 'shared', 'cli', 'adapters', 'studio', 'infra'];
  // plugins has two levels: plugins/<plugin>/<package>
  const pluginDirs = ['plugins'];

  const collect = (dir: string, maxDepth: number) => {
    if (!fs.existsSync(dir)) {return;}
    const pkgJson = path.join(dir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      tryAddPackage(pkgJson);
      return; // don't descend further if this is a package
    }
    if (maxDepth <= 0) {return;}
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) {continue;}
      collect(path.join(dir, entry.name), maxDepth - 1);
    }
  };

  const tryAddPackage = (pkgJsonPath: string) => {
    try {
      const raw = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (!raw.name) {return;}
      const dir = path.dirname(pkgJsonPath);
      packages.push({
        name: raw.name,
        dir,
        packageJsonPath: pkgJsonPath,
        layer: resolveLayer(dir, rootDir, layerMap),
        deps: Object.keys(raw.dependencies ?? {}),
        devDeps: Object.keys(raw.devDependencies ?? {}),
      });
    } catch {
      // skip malformed package.json
    }
  };

  for (const top of topDirs) {
    collect(path.join(rootDir, top), 1);
  }
  for (const top of pluginDirs) {
    collect(path.join(rootDir, top), 2);
  }

  return packages;
}

/** Build a map from package name → WorkspacePackage */
export function buildPackageMap(packages: WorkspacePackage[]): Map<string, WorkspacePackage> {
  return new Map(packages.map(p => [p.name, p]));
}
