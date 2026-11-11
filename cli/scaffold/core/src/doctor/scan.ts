import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve as resolvePath } from 'node:path';

export type Severity = 'info' | 'warn' | 'error';

export interface Finding {
  severity: Severity;
  package: string;
  message: string;
}

const INTERNAL_IMPORT_RE =
  /from\s+['"](@kb-labs\/(?:core-[a-z0-9-]+|platform-[a-z0-9-]+|core-platform(?:\/[^'"]+)?))['"]/g;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p: string): Promise<Record<string, unknown>> {
  const raw = await readFile(p, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function walkSources(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') {continue;}
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkSources(p)));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
    ) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Scan a single package directory (one that contains `package.json`).
 */
export async function scanPackage(pkgDir: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!(await exists(pkgJsonPath))) {
    return [
      {
        severity: 'error',
        package: pkgDir,
        message: 'missing package.json',
      },
    ];
  }
  const pkg = await readJson(pkgJsonPath);
  const pkgName = typeof pkg.name === 'string' ? pkg.name : pkgDir;

  const kb = pkg.kb as Record<string, unknown> | undefined;
  const isEntry = kb && typeof kb.manifest === 'string';

  if (isEntry) {
    const manifestPath = join(pkgDir, kb.manifest as string);
    if (!(await exists(manifestPath))) {
      findings.push({
        severity: 'warn',
        package: pkgName,
        message: `manifest not built: ${kb.manifest} missing (run pnpm build)`,
      });
    }
  }

  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;

  if (isEntry && !deps['@kb-labs/sdk'] && !devDeps['@kb-labs/sdk']) {
    findings.push({
      severity: 'error',
      package: pkgName,
      message: '@kb-labs/sdk not listed as a dependency',
    });
  }

  const srcDir = join(pkgDir, 'src');
  if (await exists(srcDir)) {
    const sources = await walkSources(srcDir);
    const offenders = new Set<string>();
    for (const file of sources) {
      const raw = await readFile(file, 'utf8');
      for (const match of raw.matchAll(INTERNAL_IMPORT_RE)) {
        if (match[1]) {offenders.add(match[1]);}
      }
    }
    if (offenders.size > 0) {
      findings.push({
        severity: 'warn',
        package: pkgName,
        message: `imports internal KB Labs packages: ${[...offenders].join(', ')} — use @kb-labs/sdk instead`,
      });
    }
  }

  const tsconfigPath = join(pkgDir, 'tsconfig.json');
  if (await exists(tsconfigPath)) {
    const tsconfig = await readJson(tsconfigPath);
    const extendsField = tsconfig.extends;
    if (
      typeof extendsField !== 'string' ||
      !extendsField.includes('@kb-labs/devkit')
    ) {
      findings.push({
        severity: 'info',
        package: pkgName,
        message:
          'tsconfig does not extend @kb-labs/devkit — custom configs may drift',
      });
    }
  }

  return findings;
}

export interface ScanResult {
  findings: Finding[];
  packagesScanned: number;
}

interface LockEntry {
  link?: string;
  enabled?: boolean;
}

interface MarketplaceLockShape {
  plugins?: Record<string, LockEntry>;
}

async function readLock(
  workspaceRoot: string,
): Promise<MarketplaceLockShape | null> {
  const lockPath = join(workspaceRoot, '.kb', 'marketplace.lock');
  if (!(await exists(lockPath))) {return null;}
  try {
    const raw = await readFile(lockPath, 'utf8');
    return JSON.parse(raw) as MarketplaceLockShape;
  } catch {
    return null;
  }
}

async function findEntryPackageDir(pkgDir: string): Promise<string | null> {
  // If pkgDir itself has a kb-manifest entry, it's already the entry package.
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (await exists(pkgJsonPath)) {
    const pkg = (await readJson(pkgJsonPath)) as { kb?: { manifest?: string } };
    if (pkg.kb?.manifest) {return pkgDir;}
  }
  // Otherwise look in packages/*-entry.
  const packagesDir = join(pkgDir, 'packages');
  if (!(await exists(packagesDir))) {return null;}
  const entries = await readdir(packagesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {continue;}
    if (!entry.name.endsWith('-entry')) {continue;}
    const candidate = join(packagesDir, entry.name);
    if (await exists(join(candidate, 'package.json'))) {return candidate;}
  }
  return null;
}

export interface ScanOptions {
  /**
   * Workspace root containing `.kb/marketplace.lock`. When provided, each
   * scaffolded plugin found is cross-checked against the lock — missing
   * entries surface as warnings so the user knows to `kb marketplace
   * link --link` or rerun `kb scaffold`.
   */
  workspaceRoot?: string;
}

/**
 * Scan a root directory containing one or more plugin packages. A plugin
 * package has either:
 *   - its own `package.json` at the root, or
 *   - a `packages/` directory with child packages.
 *
 * When `opts.workspaceRoot` is given, also cross-checks every discovered
 * scaffolded plugin against `.kb/marketplace.lock`.
 */
export async function scanRoot(
  root: string,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const findings: Finding[] = [];
  let packagesScanned = 0;

  async function visit(dir: string): Promise<void> {
    const pkgJson = join(dir, 'package.json');
    const packagesDir = join(dir, 'packages');
    if (await exists(pkgJson)) {
      findings.push(...(await scanPackage(dir)));
      packagesScanned += 1;
    }
    if (await exists(packagesDir)) {
      const entries = await readdir(packagesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {await visit(join(packagesDir, entry.name));}
      }
    }
  }

  if (!(await exists(root))) {
    return {
      findings: [
        {
          severity: 'warn',
          package: root,
          message: 'scan root does not exist',
        },
      ],
      packagesScanned: 0,
    };
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {await visit(join(root, entry.name));}
  }

  if (opts.workspaceRoot) {
    findings.push(...(await checkLockSync(root, opts.workspaceRoot)));
  }

  return { findings, packagesScanned };
}

/**
 * For each scaffolded plugin root under `scaffoldRoot`, verify that the
 * plugin's entry package is registered in `.kb/marketplace.lock`.
 *
 * Produces:
 *  - warn  "plugin not registered in marketplace.lock (run `kb marketplace plugins add --link ...`)"
 *  - warn  "lock entry points elsewhere"
 *  - info  "plugin disabled in lock"
 */
async function checkLockSync(
  scaffoldRoot: string,
  workspaceRoot: string,
): Promise<Finding[]> {
  const out: Finding[] = [];
  const lock = await readLock(workspaceRoot);

  const entries = await readdir(scaffoldRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {continue;}
    const pluginDir = join(scaffoldRoot, entry.name);
    const entryPkgDir = await findEntryPackageDir(pluginDir);
    if (!entryPkgDir) {continue;}

    const pkg = (await readJson(join(entryPkgDir, 'package.json'))) as {
      name?: string;
    };
    const pkgName = typeof pkg.name === 'string' ? pkg.name : entry.name;
    // Marketplace lock keys use plugin IDs (e.g. @kb-labs/my-notifier),
    // not entry package names (e.g. @kb-labs/my-notifier).
    const id = pkgName.replace(/-entry$/, '');

    if (!lock || !lock.plugins) {
      out.push({
        severity: 'warn',
        package: pkgName,
        message:
          'no .kb/marketplace.lock — scaffolded plugins will not be discovered until registered',
      });
      return out;
    }

    const lockEntry = lock.plugins[id];
    if (!lockEntry) {
      const hint = relative(workspaceRoot, entryPkgDir);
      out.push({
        severity: 'warn',
        package: pkgName,
        message: `not registered in marketplace.lock — run: kb marketplace plugins add --link ${hint}`,
      });
      continue;
    }

    if (lockEntry.enabled === false) {
      out.push({
        severity: 'info',
        package: pkgName,
        message: 'registered but disabled in marketplace.lock',
      });
    }

    if (typeof lockEntry.link === 'string') {
      const lockAbs = resolvePath(workspaceRoot, lockEntry.link);
      if (lockAbs !== entryPkgDir) {
        out.push({
          severity: 'warn',
          package: pkgName,
          message: `lock points at ${lockEntry.link} but scaffolded package is at ${relative(workspaceRoot, entryPkgDir)}`,
        });
      }
    }
  }

  return out;
}
