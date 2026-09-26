/**
 * Batch verification of the tarballs the Stage step already produced.
 *
 * Replaces the per-package `scripts/gates/check-pack-install.sh` (kept for
 * debugging) whose cost was ~97% `release clean install` per package (a `kb`
 * CLI boot plus a full Arborist install of the package's whole graph). Two
 * checks share this module:
 *
 *   pack-static   one process, every tarball: no workspace:/link:/file:
 *                 protocols, every declared main/module/types/bin/exports
 *                 target present, `node --check` of the main entry.
 *   pack-install  ONE consumer installing every tarball from the staging
 *                 registry (Arborist in-process), ONE import/resolve pass.
 *                 Isolated per-package installs only for a small configured
 *                 set (public standalone packages) and changed packages. A
 *                 failed aggregated install is bisected so the report still
 *                 names the offending package(s).
 *
 * Failure text deliberately reuses the phrases run-report/classify.ts already
 * classifies (`workspace-only dependency protocols`, `declared entry '…'
 * missing from packed tarball`, `failed syntax check`, `clean consumer cannot
 * import …`, EUNSUPPORTEDPROTOCOL) so hints and envelopes work unchanged.
 *
 * Every side effect (tar, node, Arborist, temp dirs) sits behind PackVerifyDeps
 * so tests run with fakes and no network.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BuiltinCheckKind, CheckPhaseTiming, CheckResultDetails, CustomCheckConfig, PackInstallConfig } from './types';
import { matchesPackagePattern } from './planner';
import { describeArboristError } from './clean-install-verify';

/** Where `release stage plan` persists the tarballs it publishes to the staging registry (repo-relative). */
export const STAGED_TARBALLS_REL_DIR = '.kb/release/staging/tarballs';

// ─── types ────────────────────────────────────────────────────────────────────

export interface StagedTarball {
  name: string;
  version: string;
  /** Absolute path to the .tgz. */
  tarball: string;
}

export interface PackedManifest {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface InstallRequest {
  consumerDir: string;
  /** npm specs: `name@version` from the staging registry, or tarball paths. */
  specs: string[];
  registry?: string;
}

export interface ImportEntry {
  name: string;
  /** `import` really loads the module; `resolve` only resolves it (apps/daemons). */
  mode: 'import' | 'resolve';
}

export interface ImportPassRequest {
  consumerDir: string;
  entries: ImportEntry[];
  perImportTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface ImportOutcome {
  name: string;
  ok: boolean;
  error?: string;
}

export interface PackVerifyDeps {
  extract(tarball: string): Promise<{ dir: string; dispose(): void }>;
  /** Returns the syntax error text, or undefined when the file parses. */
  syntaxCheck(file: string): Promise<string | undefined>;
  readManifest(tarball: string): Promise<PackedManifest | undefined>;
  /** Throws on failure; the message is what the report shows. */
  install(req: InstallRequest): Promise<void>;
  importPass(req: ImportPassRequest): Promise<ImportOutcome[]>;
  createConsumer(): { dir: string; dispose(): void };
  now(): number;
}

export interface PackFailure {
  name: string;
  path: string;
  details: CheckResultDetails;
}

export interface PackVerifyOutput {
  packages: Array<{ path: string; ok: boolean; details?: CheckResultDetails; durationMs: number }>;
  phases: CheckPhaseTiming[];
  durationMs: number;
}

export interface PackVerifyPackage {
  name: string;
  path: string;
}

// ─── default (real) dependencies ──────────────────────────────────────────────

function run(command: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs)
      : undefined;
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', err => {
      if (timer) { clearTimeout(timer); }
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on('close', code => {
      if (timer) { clearTimeout(timer); }
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

const IMPORT_WORKER = `
const entries = JSON.parse(process.argv[1]);
const timeoutMs = Number(process.argv[2]);
for (const e of entries) {
  console.log(JSON.stringify({ start: e.name }));
  try {
    if (e.mode === 'resolve') {
      import.meta.resolve(e.name);
    } else {
      let timer;
      await Promise.race([
        import(e.name),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('import timed out after ' + timeoutMs + 'ms')), timeoutMs); }),
      ]).finally(() => clearTimeout(timer));
    }
    console.log(JSON.stringify({ name: e.name, ok: true }));
  } catch (err) {
    const text = err && err.stack ? err.stack : String(err);
    console.log(JSON.stringify({ name: e.name, ok: false, error: text.split('\\n').slice(0, 4).join('\\n') }));
  }
}
process.exit(0);
`;

/**
 * One import pass: a single node process walks every entry. If a package hangs
 * or kills the process, only that package is failed and the remaining entries
 * continue in a fresh process, so one bad package cannot hide the others.
 */
export async function runImportPass(req: ImportPassRequest): Promise<ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  let pending = [...req.entries];
  const deadline = Date.now() + req.totalTimeoutMs;
  while (pending.length > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      for (const e of pending) { outcomes.push({ name: e.name, ok: false, error: `import pass timed out before ${e.name} was reached` }); }
      break;
    }
    const res = await run(
      process.execPath,
      ['--input-type=module', '-e', IMPORT_WORKER, JSON.stringify(pending), String(req.perImportTimeoutMs)],
      { cwd: req.consumerDir, timeoutMs: remaining },
    );
    const done = new Set<string>();
    let inFlight: string | undefined;
    for (const line of res.stdout.split('\n')) {
      let msg: { start?: string; name?: string; ok?: boolean; error?: string };
      try { msg = JSON.parse(line) as typeof msg; } catch { continue; }
      if (typeof msg.start === 'string') { inFlight = msg.start; continue; }
      if (typeof msg.name === 'string' && typeof msg.ok === 'boolean') {
        outcomes.push({ name: msg.name, ok: msg.ok, error: msg.error });
        done.add(msg.name);
        inFlight = undefined;
      }
    }
    pending = pending.filter(e => !done.has(e.name));
    if (pending.length === 0) { break; }
    // Process ended early: blame the entry that was in flight, retry the rest.
    const culprit = inFlight && pending.some(e => e.name === inFlight) ? inFlight : pending[0]!.name;
    const why = res.timedOut ? 'import pass timed out' : `process exited with code ${res.code ?? 'unknown'}`;
    const tail = res.stderr.trim().split('\n').slice(-4).join('\n');
    outcomes.push({ name: culprit, ok: false, error: `${why} while loading ${culprit}${tail ? `: ${tail}` : ''}` });
    pending = pending.filter(e => e.name !== culprit);
  }
  return outcomes;
}

async function arboristInstall(req: InstallRequest): Promise<void> {
  // Lazy import: Arborist is heavy and unused by pack-static.
  const { Arborist } = await import('@npmcli/arborist');
  // audit:false — see clean-install-verify.ts: reify() otherwise awaits a bulk
  // advisory request that has no bearing on this check.
  const arb = new Arborist({
    path: req.consumerDir,
    ignoreScripts: true,
    audit: false,
    ...(req.registry ? { registry: req.registry } : {}),
  });
  try {
    await arb.reify({ add: req.specs, save: false });
  } catch (err) {
    throw new Error(`install failed: ${describeArboristError(err)}`);
  }
}

export const defaultPackVerifyDeps: PackVerifyDeps = {
  async extract(tarball) {
    const dir = mkdtempSync(join(tmpdir(), 'kb-pack-static-'));
    const res = await run('tar', ['xzf', tarball, '-C', dir]);
    if (res.code !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`could not extract ${tarball}: ${res.stderr.trim() || `tar exited with ${res.code}`}`);
    }
    return { dir: join(dir, 'package'), dispose: () => rmSync(dir, { recursive: true, force: true }) };
  },
  async syntaxCheck(file) {
    const res = await run(process.execPath, ['--check', file], { timeoutMs: 20_000 });
    return res.code === 0 ? undefined : (res.stderr.trim() || `node --check exited with ${res.code}`);
  },
  async readManifest(tarball) {
    const res = await run('tar', ['xOf', tarball, 'package/package.json']);
    if (res.code !== 0) { return undefined; }
    try { return JSON.parse(res.stdout) as PackedManifest; } catch { return undefined; }
  },
  install: arboristInstall,
  importPass: runImportPass,
  createConsumer() {
    const dir = mkdtempSync(join(tmpdir(), 'kb-pack-install-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'kb-release-consumer', private: true }) + '\n');
    return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
  },
  now: () => Date.now(),
};

// ─── helpers ──────────────────────────────────────────────────────────────────

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) { return; }
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function failure(path: string, message: string, durationMs = 0): PackVerifyOutput['packages'][number] {
  return { path, ok: false, durationMs, details: { packagePath: path, stderr: message, exitCode: 1, error: 'exit code 1' } };
}

function normalizeEntry(entry: string): string {
  return entry.replace(/^\.\//, '');
}

/** Every file target a manifest promises: main/module/types/typings/bin/exports leaves. */
export function collectDeclaredEntries(pkg: PackedManifest): string[] {
  const entries = new Set<string>();
  for (const v of [pkg.main, pkg.module, pkg.types, pkg.typings]) {
    if (typeof v === 'string') { entries.add(v); }
  }
  if (typeof pkg.bin === 'string') {
    entries.add(pkg.bin);
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const v of Object.values(pkg.bin)) { if (typeof v === 'string') { entries.add(v); } }
  }
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { entries.add(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') { Object.values(node).forEach(walk); }
  };
  walk(pkg.exports);
  return [...entries].filter(e => !e.includes('*') && (e.startsWith('./') || !e.startsWith('.') ) && !/^[a-z]+:/i.test(e));
}

function pickJsTarget(node: unknown): string | undefined {
  if (typeof node === 'string') { return node; }
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const o = node as Record<string, unknown>;
    for (const key of ['import', 'default', 'require', 'node']) {
      const found = pickJsTarget(o[key]);
      if (found) { return found; }
    }
  }
  return undefined;
}

/** Main JS entry the syntax check runs on (same choice the shell gate made). */
export function resolveMainEntry(pkg: PackedManifest): string {
  const exp = pkg.exports;
  let dot: unknown;
  if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
    const keys = Object.keys(exp);
    dot = keys.some(k => k.startsWith('.')) ? (exp as Record<string, unknown>)['.'] : exp;
  } else {
    dot = exp;
  }
  return normalizeEntry(pickJsTarget(dot) ?? pkg.main ?? 'dist/index.js');
}

const PROTOCOL_RE = /^(workspace:|link:|file:)/;

export function findWorkspaceProtocols(pkg: PackedManifest): string[] {
  const issues: string[] = [];
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'] as const) {
    for (const [name, value] of Object.entries(pkg[section] ?? {})) {
      if (typeof value === 'string' && PROTOCOL_RE.test(value)) { issues.push(`${section}.${name}=${value}`); }
    }
  }
  return issues;
}

// ─── phase 1: batch static checks ─────────────────────────────────────────────

export interface StaticPackageResult {
  name: string;
  path: string;
  ok: boolean;
  issues: string[];
  manifest?: PackedManifest;
}

/** Static checks for ONE extracted package; returns messages in classifier-friendly wording. */
async function checkExtracted(dir: string, deps: PackVerifyDeps): Promise<{ issues: string[]; manifest?: PackedManifest }> {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) {
    return { issues: ["ERROR: declared entry 'package.json' missing from packed tarball"] };
  }
  let manifest: PackedManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackedManifest;
  } catch (err) {
    return { issues: [`ERROR: packed package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const issues: string[] = [];

  const protocols = findWorkspaceProtocols(manifest);
  if (protocols.length > 0) {
    issues.push(`ERROR: packed manifest contains workspace-only dependency protocols:\n  ${protocols.join('\n  ')}`);
  }

  for (const entry of collectDeclaredEntries(manifest)) {
    if (!existsSync(join(dir, normalizeEntry(entry)))) {
      issues.push(`ERROR: declared entry '${entry}' missing from packed tarball`);
    }
  }

  const main = resolveMainEntry(manifest);
  const mainFull = join(dir, main);
  if (/\.(?:c|m)?js$/.test(main) && existsSync(mainFull)) {
    const err = await deps.syntaxCheck(mainFull);
    if (err) { issues.push(`ERROR: ${main} failed syntax check\n${err}`); }
  }
  return { issues, manifest };
}

export async function verifyPackedArtifactsStatic(
  packages: PackVerifyPackage[],
  artifacts: StagedTarball[],
  deps: PackVerifyDeps,
  concurrency = 8,
): Promise<StaticPackageResult[]> {
  const byName = new Map(artifacts.map(a => [a.name, a]));
  return mapLimit(packages, concurrency, async pkg => {
    const artifact = byName.get(pkg.name);
    if (!artifact) {
      return { name: pkg.name, path: pkg.path, ok: false, issues: [`ERROR: no staged tarball found for ${pkg.name} (expected from the Stage step)`] };
    }
    let extracted: Awaited<ReturnType<PackVerifyDeps['extract']>> | undefined;
    try {
      extracted = await deps.extract(artifact.tarball);
      const { issues, manifest } = await checkExtracted(extracted.dir, deps);
      return { name: pkg.name, path: pkg.path, ok: issues.length === 0, issues, manifest };
    } catch (err) {
      return { name: pkg.name, path: pkg.path, ok: false, issues: [`ERROR: ${err instanceof Error ? err.message : String(err)}`] };
    } finally {
      extracted?.dispose();
    }
  });
}

export async function runPackStaticCheck(
  packages: PackVerifyPackage[],
  artifacts: StagedTarball[],
  deps: PackVerifyDeps,
): Promise<PackVerifyOutput> {
  const start = deps.now();
  const results = await verifyPackedArtifactsStatic(packages, artifacts, deps);
  const durationMs = deps.now() - start;
  return {
    packages: results.map(r => r.ok
      ? { path: r.path, ok: true, durationMs: 0 }
      : failure(r.path, r.issues.join('\n'))),
    phases: [{ name: 'static-checks', durationMs, detail: `${results.length} tarball(s) in one process` }],
    durationMs,
  };
}

// ─── phase 2: aggregated install + one import pass ────────────────────────────

export function isAppPackage(name: string, manifest: PackedManifest | undefined, config: PackInstallConfig): boolean {
  if (config.appPackages?.length && matchesPackagePattern(name, '', config.appPackages)) { return true; }
  if (config.detectApps === false) { return false; }
  if (manifest?.bin) { return true; }
  return /(?:^|[-/])(?:app|daemon)$/.test(name);
}

interface SubsetOutcome {
  ok: boolean;
  /** Install error when ok is false. */
  error?: string;
  imports: ImportOutcome[];
}

class Budget {
  used = 0;
  constructor(readonly max: number) {}
  get exhausted(): boolean { return this.used >= this.max; }
}

export interface PackInstallInputs {
  packages: PackVerifyPackage[];
  artifacts: StagedTarball[];
  /** Staging registry; when unset the tarballs themselves are installed. */
  registry?: string;
  /** Names the planner marks as changed since the last release. */
  changedPackages?: string[];
  config: PackInstallConfig;
  timeoutMs: number;
}

export async function runPackInstallCheck(input: PackInstallInputs, deps: PackVerifyDeps): Promise<PackVerifyOutput> {
  const startedAt = deps.now();
  const phases: CheckPhaseTiming[] = [];
  const results = new Map<string, PackVerifyOutput['packages'][number]>();
  const byName = new Map(input.artifacts.map(a => [a.name, a]));
  const pathOf = new Map(input.packages.map(p => [p.name, p.path]));
  const config = input.config;
  const perImportTimeoutMs = config.importTimeoutMs ?? 20_000;

  const installable: StagedTarball[] = [];
  for (const pkg of input.packages) {
    const artifact = byName.get(pkg.name);
    if (artifact) { installable.push(artifact); } else {
      results.set(pkg.name, failure(pkg.path, `ERROR: no staged tarball found for ${pkg.name}; cannot install it into a clean consumer`));
    }
  }

  const manifests = new Map<string, PackedManifest | undefined>();
  await mapLimit(installable, 8, async a => { manifests.set(a.name, await deps.readManifest(a.tarball)); });
  const entriesFor = (subset: StagedTarball[]): ImportEntry[] => subset.map(a => ({
    name: a.name,
    mode: isAppPackage(a.name, manifests.get(a.name), config) ? 'resolve' : 'import',
  }));
  const specFor = (a: StagedTarball): string => (input.registry ? `${a.name}@${a.version}` : a.tarball);

  const timedOut = (ms: number): Promise<never> => new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`install timed out after ${input.timeoutMs}ms`)), ms);
    t.unref?.();
  });

  const installAndImport = async (subset: StagedTarball[]): Promise<SubsetOutcome> => {
    const consumer = deps.createConsumer();
    try {
      try {
        await Promise.race([
          deps.install({ consumerDir: consumer.dir, specs: subset.map(specFor), registry: input.registry }),
          timedOut(input.timeoutMs),
        ]);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), imports: [] };
      }
      const imports = await deps.importPass({
        consumerDir: consumer.dir,
        entries: entriesFor(subset),
        perImportTimeoutMs,
        totalTimeoutMs: Math.max(input.timeoutMs, 60_000),
      });
      return { ok: true, imports };
    } finally {
      consumer.dispose();
    }
  };

  const recordImports = (imports: ImportOutcome[]): void => {
    for (const o of imports) {
      const path = pathOf.get(o.name);
      if (!path) { continue; }
      if (o.ok) { if (!results.has(o.name)) { results.set(o.name, { path, ok: true, durationMs: 0 }); } continue; }
      results.set(o.name, failure(path, `ERROR: clean consumer cannot import ${o.name}${o.error ? `: ${o.error}` : ''}`));
    }
  };

  // 1. aggregated install of everything --------------------------------------
  if (installable.length > 0) {
    const t0 = deps.now();
    const aggregate = await installAndImport(installable);
    const aggMs = deps.now() - t0;
    phases.push({ name: 'aggregated-install+import', durationMs: aggMs, detail: `${installable.length} package(s), ${aggregate.ok ? 'ok' : 'install failed'}` });

    if (aggregate.ok) {
      recordImports(aggregate.imports);
    } else {
      // 2. bisect the failing subset --------------------------------------------
      const b0 = deps.now();
      const budget = new Budget(config.maxBisectInstalls ?? 40);
      const bisect = async (subset: StagedTarball[], error: string): Promise<void> => {
        if (subset.length === 1) {
          const a = subset[0]!;
          results.set(a.name, failure(pathOf.get(a.name)!, `ERROR: ${a.name}@${a.version} cannot be installed by a clean consumer\n${error}`));
          return;
        }
        if (budget.exhausted) {
          for (const a of subset) {
            results.set(a.name, failure(pathOf.get(a.name)!, `ERROR: aggregated install failed and the bisect budget (${budget.max}) ran out before isolating ${a.name}\n${error}`));
          }
          return;
        }
        const mid = Math.ceil(subset.length / 2);
        const halves = [subset.slice(0, mid), subset.slice(mid)];
        let anyHalfFailed = false;
        for (const half of halves) {
          budget.used++;
          const r = await installAndImport(half);
          if (r.ok) { recordImports(r.imports); } else { anyHalfFailed = true; await bisect(half, r.error ?? error); }
        }
        if (!anyHalfFailed) {
          // Each half installs alone: the failure is an interaction (conflicting ranges).
          for (const a of subset) {
            results.set(a.name, failure(pathOf.get(a.name)!, `ERROR: ${a.name}@${a.version} installs alone but not together with ${subset.length - 1} other package(s) (dependency conflict)\n${error}`));
          }
        }
      };
      await bisect(installable, aggregate.error ?? 'install failed');
      phases.push({ name: 'bisect', durationMs: deps.now() - b0, detail: `${budget.used} extra install(s)` });
    }
  }

  // 3. isolated installs for the small standalone/changed subset ----------------
  const isolatedNames = new Set<string>();
  for (const a of installable) {
    if (config.isolatedPackages?.length && matchesPackagePattern(a.name, '', config.isolatedPackages)) { isolatedNames.add(a.name); }
  }
  const explicitCount = isolatedNames.size;
  let truncated = 0;
  if (config.isolateChanged !== false) {
    const limit = config.maxIsolatedChanged ?? 15;
    const changed = installable.filter(a => input.changedPackages?.includes(a.name) && !isolatedNames.has(a.name)).map(a => a.name).sort();
    for (const name of changed.slice(0, limit)) { isolatedNames.add(name); }
    truncated = Math.max(0, changed.length - limit);
  }
  if (isolatedNames.size > 0) {
    const i0 = deps.now();
    const subset = installable.filter(a => isolatedNames.has(a.name));
    const isolated = await mapLimit(subset, config.isolatedConcurrency ?? 2, async a => ({ a, r: await installAndImport([a]) }));
    for (const { a, r } of isolated) {
      const path = pathOf.get(a.name)!;
      if (!r.ok) {
        results.set(a.name, failure(path, `ERROR: ${a.name}@${a.version} cannot be installed by an isolated clean consumer\n${r.error ?? ''}`));
      } else {
        // Keep a failing aggregated import verdict; only add isolated import failures.
        for (const o of r.imports.filter(x => !x.ok)) {
          results.set(o.name, failure(path, `ERROR: clean consumer cannot import ${o.name} (isolated install)${o.error ? `: ${o.error}` : ''}`));
        }
      }
    }
    phases.push({
      name: 'isolated-installs',
      durationMs: deps.now() - i0,
      detail: `${subset.length} package(s) (${explicitCount} configured, ${subset.length - explicitCount} changed)` +
        (truncated > 0 ? `; ${truncated} more changed package(s) covered only by the aggregated install (maxIsolatedChanged)` : ''),
    });
  }

  const packages = input.packages.map(p => results.get(p.name) ?? { path: p.path, ok: true, durationMs: 0 });
  return { packages, phases, durationMs: deps.now() - startedAt };
}

// ─── artifact resolution (reuse the Stage step's tarballs) ────────────────────

export interface ResolveArtifactsInput {
  /** Planned packages (name + version the staging registry must hold). */
  packages: Array<{ name: string; version: string }>;
  /** Directory holding manifest.json + tarballs written by `release stage plan`. */
  stagedDir?: string;
  /** Staging registry used as a fallback source of the very same tarballs. */
  registry?: string;
  fetchImpl?: typeof fetch;
}

export interface ResolvedArtifacts {
  artifacts: StagedTarball[];
  source: 'staged-dir' | 'registry' | 'mixed' | 'none';
}

interface StagedManifestEntry { name: string; version: string; tarball: string }

export async function resolveStagedArtifacts(input: ResolveArtifactsInput): Promise<ResolvedArtifacts> {
  const artifacts: StagedTarball[] = [];
  let fromDir = 0;
  let fromRegistry = 0;

  const local = new Map<string, StagedTarball>();
  if (input.stagedDir) {
    const manifestPath = join(input.stagedDir, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const entries = JSON.parse(readFileSync(manifestPath, 'utf8')) as StagedManifestEntry[];
        for (const e of entries) {
          const abs = join(input.stagedDir, e.tarball);
          if (existsSync(abs)) { local.set(`${e.name}@${e.version}`, { name: e.name, version: e.version, tarball: abs }); }
        }
      } catch { /* unreadable manifest: fall through to the registry */ }
    }
  }

  const downloadDir = input.registry ? mkdtempSync(join(tmpdir(), 'kb-staged-download-')) : undefined;
  for (const pkg of input.packages) {
    const hit = local.get(`${pkg.name}@${pkg.version}`);
    if (hit) { artifacts.push(hit); fromDir++; continue; }
    if (!input.registry || !downloadDir) { continue; }
    const fetched = await downloadFromRegistry(input.registry, pkg, downloadDir, input.fetchImpl ?? fetch);
    if (fetched) { artifacts.push(fetched); fromRegistry++; }
  }

  const source = fromDir > 0 && fromRegistry > 0 ? 'mixed' : fromDir > 0 ? 'staged-dir' : fromRegistry > 0 ? 'registry' : 'none';
  return { artifacts, source };
}

async function downloadFromRegistry(
  registry: string,
  pkg: { name: string; version: string },
  dir: string,
  fetchImpl: typeof fetch,
): Promise<StagedTarball | undefined> {
  const base = registry.replace(/\/$/, '');
  const meta = await fetchImpl(`${base}/${pkg.name.replace('/', '%2f')}`).catch(() => undefined);
  if (!meta?.ok) { return undefined; }
  const doc = await meta.json() as { versions?: Record<string, { dist?: { tarball?: string } }> };
  const url = doc.versions?.[pkg.version]?.dist?.tarball;
  if (!url) { return undefined; }
  const res = await fetchImpl(url).catch(() => undefined);
  if (!res?.ok || !res.body) { return undefined; }
  const file = join(dir, `${pkg.name.replace(/[@/]/g, '_')}-${pkg.version}.tgz`);
  mkdirSync(dirname(file), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
  return { name: pkg.name, version: pkg.version, tarball: file };
}

// ─── runtime wiring used by runReleaseChecks ──────────────────────────────────

export interface PackVerifyRuntime {
  /** Planned packages the staged tarballs must exist for. */
  plannedPackages: Array<{ name: string; version: string }>;
  stagedDir?: string;
  registry?: string;
  changedPackages?: string[];
  deps?: Partial<PackVerifyDeps>;
  fetchImpl?: typeof fetch;
}

export interface BuiltinCheckContext {
  check: CustomCheckConfig;
  packages: PackVerifyPackage[];
  pack?: PackVerifyRuntime;
  timeoutMs: number;
}

export type BuiltinCheckHandler = (ctx: BuiltinCheckContext) => Promise<PackVerifyOutput>;

const artifactCache = new WeakMap<PackVerifyRuntime, Promise<ResolvedArtifacts>>();

function artifactsFor(pack: PackVerifyRuntime): Promise<ResolvedArtifacts> {
  let cached = artifactCache.get(pack);
  if (!cached) {
    cached = resolveStagedArtifacts({
      packages: pack.plannedPackages,
      stagedDir: pack.stagedDir,
      registry: pack.registry,
      fetchImpl: pack.fetchImpl,
    });
    artifactCache.set(pack, cached);
  }
  return cached;
}

async function runBuiltin(kind: BuiltinCheckKind, ctx: BuiltinCheckContext): Promise<PackVerifyOutput> {
  if (!ctx.pack) {
    return {
      packages: ctx.packages.map(p => failure(p.path, `ERROR: ${kind} needs the staged tarballs but no staging information was provided (RELEASE_PLAN_PATH / staging registry unset). Run \`release stage plan\` first.`)),
      phases: [],
      durationMs: 0,
    };
  }
  const deps: PackVerifyDeps = { ...defaultPackVerifyDeps, ...ctx.pack.deps };
  const t0 = deps.now();
  const resolved = await artifactsFor(ctx.pack);
  const resolveMs = deps.now() - t0;
  const resolvePhase: CheckPhaseTiming = { name: 'resolve-artifacts', durationMs: resolveMs, detail: `${resolved.artifacts.length} tarball(s) from ${resolved.source}` };
  const out = kind === 'pack-static'
    ? await runPackStaticCheck(ctx.packages, resolved.artifacts, deps)
    : await runPackInstallCheck({
        packages: ctx.packages,
        artifacts: resolved.artifacts,
        registry: ctx.pack.registry,
        changedPackages: ctx.pack.changedPackages,
        config: ctx.check.packInstall ?? {},
        timeoutMs: ctx.timeoutMs,
      }, deps);
  return { ...out, phases: [resolvePhase, ...out.phases], durationMs: out.durationMs + resolveMs };
}

export const defaultBuiltinChecks: Record<BuiltinCheckKind, BuiltinCheckHandler> = {
  'pack-static': ctx => runBuiltin('pack-static', ctx),
  'pack-install': ctx => runBuiltin('pack-install', ctx),
};
