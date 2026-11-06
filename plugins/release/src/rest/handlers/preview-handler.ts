/**
 * Preview handler - Get list of files that will be published for each package
 *
 * Uses npm-packlist to determine what files will be included in the tarball
 * Also checks build status (dist/ folder existence)
 */

import { defineHandler, findRepoRoot, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import type {
  PreviewInput,
  PreviewResponse,
  PackagePreview,
  PackageFile,
  ReleasePlan,
  BuildStatus,
} from '../../contracts/index.js';
import { readFile, stat, access } from 'node:fs/promises';
import { scopeToDir } from '../../shared/utils';
import { join } from 'node:path';
import packlist from 'npm-packlist';

/**
 * Check if dist folder exists and determine build status
 */
async function checkBuildStatus(packagePath: string): Promise<BuildStatus> {
  const distPath = join(packagePath, 'dist');
  try {
    await access(distPath);
    // TODO: Could check if dist is older than src for 'outdated' status
    return 'ready';
  } catch {
    return 'not_built';
  }
}

/**
 * Read expected files from package.json "files" field
 */
async function getExpectedFiles(packagePath: string): Promise<string[]> {
  try {
    const pkgJsonPath = join(packagePath, 'package.json');
    const pkgJson = JSON.parse(await readFile(pkgJsonPath, 'utf-8'));
    return pkgJson.files || [];
  } catch {
    return [];
  }
}

export default defineHandler({
  async execute(ctx, input: RestInput<PreviewInput>): Promise<PreviewResponse> {
    try {
    const scope = input.query?.scope || 'root';
    const cwd = ctx.cwd ?? process.cwd();
    const repoRoot = await findRepoRoot(cwd);

    // Read plan to get packages
    const scopeDir = scopeToDir(scope);
    const planPath = join(repoRoot, '.kb/release/plans', scopeDir, 'current', 'plan.json');

    let plan: ReleasePlan;
    try {
      const planRaw = await readFile(planPath, 'utf-8');
      plan = JSON.parse(planRaw);
    } catch {
      return {
        scope,
        packages: [],
        totalSize: 0,
        totalFiles: 0,
        allBuilt: false,
      };
    }

    const packages: PackagePreview[] = [];
    let totalSize = 0;
    let totalFiles = 0;
    let allBuilt = true;

    for (const pkg of plan.packages) {
      // pkg.path can be absolute or relative
      const packagePath = pkg.path.startsWith('/') ? pkg.path : join(repoRoot, pkg.path);

      // Check build status
      const buildStatus = await checkBuildStatus(packagePath);
      if (buildStatus !== 'ready') {
        allBuilt = false;
      }

      // Get expected files from package.json
      const expectedFiles = await getExpectedFiles(packagePath);

      try {
        // Read package.json to create tree object for npm-packlist v10+
        const pkgJsonPath = join(packagePath, 'package.json');
        const pkgJson = JSON.parse(await readFile(pkgJsonPath, 'utf-8'));

        // npm-packlist v10+ requires a tree-like arborist node with:
        // - path: package path
        // - package: package.json content (must have bundleDependencies if not isProjectRoot)
        // - isProjectRoot: true to use bundleDependencies instead of all deps
        // - edgesOut: Map of dependency edges (not needed if bundleDependencies is empty)
        // npm-packlist v10+ reads tree.path and tree.package at runtime.
        // @types/npm-packlist expects an arborist Node, but a plain object works fine —
        // cast to avoid the type mismatch without installing the full @npmcli/arborist types.
        const tree = {
          path: packagePath,
          isProjectRoot: true,
          package: {
            ...pkgJson,
            bundleDependencies: pkgJson.bundleDependencies || [],
          },
        } as Parameters<typeof packlist>[0];
        const files = await packlist(tree);

        // Get file sizes
        const filesWithSize: PackageFile[] = await Promise.all(
          files.map(async (filePath: string): Promise<PackageFile> => {
            try {
              const fullPath = join(packagePath, filePath);
              const stats = await stat(fullPath);
              return {
                path: filePath,
                size: stats.size,
              };
            } catch {
              return {
                path: filePath,
                size: 0,
              };
            }
          })
        );

        const packageTotalSize = filesWithSize.reduce((sum: number, f: PackageFile) => sum + f.size, 0);

        packages.push({
          name: pkg.name,
          version: pkg.nextVersion,
          path: pkg.path,
          buildStatus,
          files: filesWithSize,
          expectedFiles: expectedFiles.length > 0 ? expectedFiles : undefined,
          totalSize: packageTotalSize,
          fileCount: files.length,
        });

        totalSize += packageTotalSize;
        totalFiles += files.length;
      } catch {
        // If we can't read the package, add it with empty files
        packages.push({
          name: pkg.name,
          version: pkg.nextVersion,
          path: pkg.path,
          buildStatus,
          files: [],
          expectedFiles: expectedFiles.length > 0 ? expectedFiles : undefined,
          totalSize: 0,
          fileCount: 0,
        });
      }
    }

    return {
      scope,
      packages,
      totalSize,
      totalFiles,
      allBuilt,
    };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
