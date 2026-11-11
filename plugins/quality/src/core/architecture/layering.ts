/**
 * Layering violation detector using TypeScript compiler API.
 *
 * Checks that imports respect the layer hierarchy defined in CLAUDE.md:
 *   Layer 0: core/
 *   Layer 1: sdk/ shared/
 *   Layer 2: cli/ adapters/
 *   Layer 3: plugins/
 *   Layer 4: studio/ sites/
 *
 * A violation = a package at layer N importing a package at layer M where M > N.
 */

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import globby from 'globby';
import { defaultQualityConfig, type LayeringReport, type LayeringViolation, type QualityLayerMap } from '../../contracts/index.js';
import { scanWorkspace, buildPackageMap, resolveLayer } from '../workspace/scan-workspace.js';

/** Extract all import/export-from specifiers from a TS source file via AST */
function extractImportSpecifiers(filePath: string): string[] {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];

  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return specifiers;
}

/**
 * Resolve an import specifier to a workspace package name.
 * Returns null for relative imports, node: builtins, and external deps not in workspace.
 */
function resolveToPackageName(
  specifier: string,
  workspaceNames: Set<string>
): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('node:')) {return null;}

  // Scoped package: @scope/name or @scope/name/subpath
  const scoped = specifier.match(/^(@[^/]+\/[^/]+)/);
  if (scoped) {
    const pkg = scoped[1]!;
    return workspaceNames.has(pkg) ? pkg : null;
  }

  // Unscoped: take first segment
  const name = specifier.split('/')[0];
  if (name) {return workspaceNames.has(name) ? name : null;}

  return null;
}

export interface LayeringOptions {
  rootDir: string;
  layerMap?: QualityLayerMap;
}

/** Run layering analysis and return violations */
export async function analyzeLayering(opts: LayeringOptions): Promise<LayeringReport> {
  const { rootDir, layerMap } = opts;

  const packages = scanWorkspace(rootDir, layerMap);
  const packageMap = buildPackageMap(packages);
  const workspaceNames = new Set(packageMap.keys());

  const violations: LayeringViolation[] = [];

  // For each package, scan all its TS source files
  await Promise.all(
    packages
      .filter(pkg => pkg.layer >= 0) // skip unknown-layer packages (e2e, templates, etc.)
      .map(async pkg => {
        const srcDir = path.join(pkg.dir, 'src');
        if (!fs.existsSync(srcDir)) {return;}

        const files = await globby('**/*.{ts,tsx}', {
          cwd: srcDir,
          ignore: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**', '**/node_modules/**'],
          absolute: true,
          deep: 10,
        });

        for (const file of files) {
          const specifiers = extractImportSpecifiers(file);
          for (const spec of specifiers) {
            const importedPkg = resolveToPackageName(spec, workspaceNames);
            if (!importedPkg) {continue;}

            const importedLayer = packageMap.get(importedPkg)?.layer ?? resolveLayer(importedPkg, rootDir, layerMap);
            if (importedLayer < 0) {continue;}

            // Violation: current package imports from a higher layer
            if (importedLayer > pkg.layer) {
              violations.push({
                file,
                fromPackage: pkg.name,
                fromLayer: pkg.layer,
                toPackage: importedPkg,
                toLayer: importedLayer,
                importSpecifier: spec,
              });
            }
          }
        }
      })
  );

  const affectedPackages = [...new Set(violations.map(v => v.fromPackage))];

  return {
    violations,
    totalViolations: violations.length,
    affectedPackages,
    layerMap: layerMap ?? defaultQualityConfig.layers,
  };
}
