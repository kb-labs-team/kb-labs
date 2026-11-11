/**
 * Package verifier — npm pack → extract → verify artifacts before publish.
 * Catches: directory imports, test file leaks, missing exports, syntax errors.
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import type { VerifyResult, PackageVersion, PluginLogger } from './types';

/**
 * Verify all packages in a plan are publishable.
 */
export async function verifyPackages(
  packages: PackageVersion[],
  options?: {
    logger?: Pick<PluginLogger, 'info'>;
    onProgress?: (pkg: string, result: VerifyResult) => void;
    packageManager?: 'pnpm' | 'npm' | 'yarn';
  },
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];

  for (const pkg of packages) {
    const result = verifyPackage(pkg.path, pkg.name, options?.packageManager);
    results.push(result);
    options?.onProgress?.(pkg.name, result);
  }

  return results;
}

/**
 * Verify a single package is publishable.
 * pack → extract → check exports, directory imports, test leaks, syntax.
 *
 * Packing tool must match what the real publish step will actually use:
 * `pnpm pack` resolves `workspace:`/`link:` protocol refs to real version
 * ranges natively (confirmed: `pnpm pack` on a package with
 * `peerDependencies: { "@kb-labs/sdk": "workspace:^" }` produces a tarball
 * with `"@kb-labs/sdk": "^2.115.4"`). `npm pack` does not — it packs the
 * manifest byte-for-byte, so an unrewritten `workspace:*`/`link:` ref
 * survives into the tarball and gets correctly flagged by
 * findForbiddenDependencyProtocols() below. Defaulting to 'npm' here when
 * the caller doesn't say otherwise is deliberately the strict reading (catch
 * it even if we don't know yet what will actually publish); passing 'pnpm'
 * for a pipeline that really does pack with pnpm avoids false positives on
 * refs pnpm already resolves for free.
 */
export function verifyPackage(
  packagePath: string,
  packageName?: string,
  packageManager: 'pnpm' | 'npm' | 'yarn' = 'npm',
): VerifyResult {
  const pkgJsonPath = join(packagePath, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return { name: packageName ?? packagePath, success: true, issues: [] }; // skip
  }

  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  const name = packageName ?? pkg.name ?? packagePath;

  // Skip private packages
  if (pkg.private) {
    return { name, success: true, issues: [] };
  }

  if (!existsSync(join(packagePath, 'dist'))) {
    return { name, success: true, issues: [] }; // no dist = not built yet
  }

  const issues: string[] = [];
  const tmpDir = join(tmpdir(), `kb-verify-${randomBytes(6).toString('hex')}`);

  try {
    mkdirSync(tmpDir, { recursive: true });

    const isPnpm = packageManager === 'pnpm';

    // 1. pack — pnpm resolves workspace:/link: refs on its own; npm/yarn need
    // the manual link: → * patch since they don't understand either protocol.
    const origPkg = readFileSync(pkgJsonPath, 'utf-8');
    if (!isPnpm) {
      const modPkg = JSON.parse(origPkg);
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const deps = modPkg[section];
        if (!deps) {continue;}
        for (const [k, v] of Object.entries(deps)) {
          if (typeof v === 'string' && (v as string).startsWith('link:')) {
            deps[k] = '*';
          }
        }
      }
      writeFileSync(pkgJsonPath, JSON.stringify(modPkg, null, 2) + '\n');
    }

    let tgzFile: string | undefined;
    try {
      spawnSync(isPnpm ? 'pnpm' : 'npm', ['pack', '--pack-destination', tmpDir], { cwd: packagePath, stdio: 'pipe', timeout: 30_000 });
      const files = readdirSync(tmpDir).filter(f => f.endsWith('.tgz'));
      tgzFile = files[0] ? join(tmpDir, files[0]) : undefined;
    } finally {
      // Always restore original package.json
      writeFileSync(pkgJsonPath, origPkg);
    }

    if (!tgzFile) {
      issues.push('npm pack produced no tarball');
      return { name, success: false, issues };
    }

    // 2. Extract
    spawnSync('tar', ['xzf', tgzFile], { cwd: tmpDir, stdio: 'pipe' });
    const extractedDir = join(tmpDir, 'package');

    issues.push(...verifyExtractedTarball(extractedDir));
  } catch (err) {
    issues.push(`Verification error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  return { name, success: issues.length === 0, issues };
}

/** Verify the exact prebuilt archive and its declared package identity offline. */
export function verifyPackageTarball(tarball: string, name: string, version: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'kb-release-verify-'));
  try {
    const extracted = spawnSync('tar', ['xzf', tarball, '-C', dir], { stdio: 'pipe' });
    if (extracted.status !== 0) return [`Could not extract package archive for ${name}@${version}`];
    const packageDir = join(dir, 'package');
    const manifest: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    if (typeof manifest !== 'object' || manifest === null || !('name' in manifest) || !('version' in manifest) || manifest.name !== name || manifest.version !== version) {
      return [`Package identity does not match ${name}@${version}`];
    }
    if ('private' in manifest && manifest.private === true) return [`Package ${name}@${version} is marked private`];
    return verifyExtractedTarball(packageDir);
  } catch (error) {
    return [`Package verification failed for ${name}@${version}: ${error instanceof Error ? error.message : String(error)}`];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the static artifact checks (test-file leaks, exports existence,
 * directory-import detection, syntax validation) against an already
 * extracted package tarball. Shared by verifyPackage() (local npm pack)
 * and verdaccio-verify.ts (npm pack pulled from a registry) so both
 * "verify before publish" and "verify after publish" use identical checks.
 */
export function verifyExtractedTarball(extractedDir: string): string[] {
  const issues: string[] = [];

  // Test file leaks
  const testFiles = findFiles(join(extractedDir, 'dist'), f =>
    f.includes('.spec.') || f.includes('.test.') || f.includes('__tests__')
  );
  if (testFiles.length > 0) {
    issues.push(`Test files in dist/: ${testFiles.slice(0, 3).join(', ')}`);
  }

  // Exports exist
  const extractedPkg = JSON.parse(readFileSync(join(extractedDir, 'package.json'), 'utf-8')) as PkgJson;
  issues.push(...findForbiddenDependencyProtocols(extractedPkg));
  for (const field of ['main', 'module', 'types'] as const) {
    const val = extractedPkg[field];
    if (val && !existsSync(join(extractedDir, val))) {
      issues.push(`${field}: ${val} does not exist in published package`);
    }
  }

  if (extractedPkg.exports) {
    checkExportsExist(extractedPkg.exports, extractedDir, 'exports', issues);
  }

  // Directory imports in ESM entry
  const esmEntry = resolveEsmEntry(extractedPkg);
  if (esmEntry) {
    const esmPath = join(extractedDir, esmEntry);
    if (existsSync(esmPath)) {
      checkDirectoryImports(esmPath, join(extractedDir, 'dist'), issues);

      // Syntax check
      const esmCheck = spawnSync('node', ['--check', esmPath], { stdio: 'pipe', timeout: 10_000 });
      if (esmCheck.status !== 0) {
        issues.push(`ESM syntax error in ${esmEntry}`);
      }
    }
  }

  // CJS syntax check
  const cjsEntry = resolveCjsEntry(extractedPkg);
  if (cjsEntry) {
    const cjsPath = join(extractedDir, cjsEntry);
    if (existsSync(cjsPath)) {
      const cjsCheck = spawnSync('node', ['--check', cjsPath], { stdio: 'pipe', timeout: 10_000 });
      if (cjsCheck.status !== 0) {
        issues.push(`CJS syntax error in ${cjsEntry}`);
      }
    }
  }

  return issues;
}

/**
 * These protocols are workspace-only and cannot be consumed from a public
 * registry. Checking the extracted package (rather than the source manifest)
 * makes this a release-artifact contract and catches the exact bytes a user
 * would install.
 */
export function findForbiddenDependencyProtocols(pkg: PkgJson): string[] {
  const issues: string[] = [];
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'] as const) {
    const deps = pkg[section];
    if (!deps || typeof deps !== 'object') { continue; }
    for (const [name, value] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof value !== 'string') { continue; }
      const protocol = ['workspace:', 'link:', 'file:'].find(prefix => value.startsWith(prefix));
      if (protocol) {
        issues.push(`${section}.${name} uses forbidden ${protocol} dependency protocol (${value})`);
      }
    }
  }
  return issues;
}

type PkgJson = Record<string, unknown> & {
  exports?: Record<string, Record<string, string> | string>;
  module?: string;
  main?: string;
  types?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function resolveEsmEntry(pkg: PkgJson): string | undefined {
  const dotExport = pkg.exports?.['.'];
  const importEntry = dotExport && typeof dotExport === 'object' ? (dotExport as Record<string, string>)['import'] : undefined;
  return importEntry ?? pkg.module ?? pkg.main;
}

function resolveCjsEntry(pkg: PkgJson): string | undefined {
  const dotExport = pkg.exports?.['.'];
  const req = dotExport && typeof dotExport === 'object' ? (dotExport as Record<string, string>)['require'] : undefined;
  if (req) {return req;}
  if (pkg.main?.endsWith('.cjs')) {return pkg.main;}
  return undefined;
}

function checkExportsExist(exports: unknown, baseDir: string, prefix: string, issues: string[]): void {
  if (typeof exports === 'string') {
    // Skip wildcard patterns like "./dist/*" — can't verify statically
    if (exports.includes('*')) { return; }
    if (!existsSync(join(baseDir, exports))) {
      issues.push(`${prefix}: ${exports} missing`);
    }
  } else if (exports && typeof exports === 'object') {
    for (const [k, v] of Object.entries(exports)) {
      // Skip wildcard export keys like "./dist/*"
      if (k.includes('*')) { continue; }
      checkExportsExist(v, baseDir, `${prefix}.${k}`, issues);
    }
  }
}

function checkDirectoryImports(filePath: string, distDir: string, issues: string[]): void {
  const content = readFileSync(filePath, 'utf-8');
  const importRegex = /(?:export|import)\s.*?from\s+['"](\.[^'"]*)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    const target = match[1];
    if (!target || target.includes('.')) {continue;} // has extension, ok
    const targetPath = resolve(dirname(filePath), target);
    if (existsSync(targetPath) && statSync(targetPath).isDirectory()) {
      issues.push(`Directory import '${target}' in ${filePath.split('/').pop()}`);
    }
  }
}

function findFiles(dir: string, predicate: (f: string) => boolean): string[] {
  if (!existsSync(dir)) {return [];}
  const results: string[] = [];
  function walk(d: string) {
    try {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) {walk(full);}
        else if (predicate(full)) {results.push(entry.name);}
      }
    } catch { /* skip */ }
  }
  walk(dir);
  return results;
}
