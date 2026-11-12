// Public API: sync runner used by bin and by consumers via import('@kb-labs/devkit/sync')
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile, access, chmod } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { glob } from 'glob';

// helpers
async function readDevkitMeta() {
  try {
    const pkgJson = JSON.parse(await readFile(resolve(DEVKIT_ROOT, 'package.json'), 'utf8'));
    return { name: pkgJson.name ?? '@kb-labs/devkit', version: pkgJson.version ?? null, description: pkgJson.description ?? null, commit: null };
  } catch {
    return { name: '@kb-labs/devkit', version: null, description: null, commit: null };
  }
}
function nowIso() { return new Date().toISOString(); }
function relFromDevkit(absPath) {
  const p = absPath && absPath.startsWith(DEVKIT_ROOT) ? absPath.slice(DEVKIT_ROOT.length + 1) : absPath;
  return (p ?? '').replaceAll('\\', '/');
}
function relFromRepo(root, absPath) {
  const p = absPath && absPath.startsWith(root) ? absPath.slice(root.length + 1) : absPath;
  return (p ?? '').replaceAll('\\', '/');
}
function cryptoRandomId() {
  return createHash('sha256').update(String(Math.random()) + String(Date.now())).digest('hex').slice(0, 32);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEVKIT_ROOT = resolve(__dirname, '..');

const BASE_MAP = {
  agents: {
    from: resolve(DEVKIT_ROOT, 'agents'),
    to: (root) => resolve(root, '.kb/devkit/agents'),
    type: 'dir',
  },
  cursorrules: {
    from: resolve(DEVKIT_ROOT, '.cursorrules'),
    to: (root) => resolve(root, '.cursorrules'),
    type: 'file',
  },
  vscode: {
    from: resolve(DEVKIT_ROOT, '.vscode/settings.json'),
    to: (root) => resolve(root, '.vscode/settings.json'),
    type: 'file',
  },
  ci: {
    from: resolve(DEVKIT_ROOT, '.github/workflow-templates'),
    to: (root) => resolve(root, '.github/workflows'),
    type: 'dir',
  },
  configs: {
    from: resolve(DEVKIT_ROOT, 'templates/configs'),
    to: (root) => root, // Root of package
    type: 'configs', // Special type for config drift checking
  },
  hooks: {
    from: resolve(DEVKIT_ROOT, 'scripts/hooks'),
    to: (root) => resolve(root, 'scripts/hooks'),
    type: 'hooks', // Special type: also installs into .git/hooks/
  },
};

function resolveFromDevkit(p) {
  return p && p.startsWith('/') ? p : resolve(DEVKIT_ROOT, p);
}

function buildEffectiveMap(projectCfg) {
  const map = Object.fromEntries(Object.entries(BASE_MAP).map(([k, v]) => [k, { ...v }]));
  const syncCfg = projectCfg?.sync || {};

  if (syncCfg.overrides && typeof syncCfg.overrides === 'object') {
    for (const [key, ov] of Object.entries(syncCfg.overrides)) {
      if (!map[key]) {continue;}
      if (ov.from) {map[key].from = resolveFromDevkit(String(ov.from));}
      if (ov.to) {map[key].to = (root) => resolve(root, String(ov.to));}
      if (ov.type) {map[key].type = String(ov.type);}
    }
  }

  if (syncCfg.targets && typeof syncCfg.targets === 'object') {
    for (const [key, t] of Object.entries(syncCfg.targets)) {
      if (!t?.from || !t?.to) {continue;}
      map[key] = {
        from: resolveFromDevkit(String(t.from)),
        to: (root) => resolve(root, String(t.to)),
        type: String(t.type || 'dir'),
      };
    }
  }
  return map;
}

const log = (...a) => console.log('[devkit-sync]', ...a);
const warn = (...a) => console.warn('[devkit-sync]', ...a);

function relativeTsconfigPath(from, to) {
  const path = relative(from, to);
  return path.startsWith('.') ? path : `./${path}`;
}

async function exists(p) { try { await access(p); return true; } catch { return false; } }
async function ensureDirForFile(p) { await mkdir(dirname(p), { recursive: true }); }

async function sha256File(p) {
  const buf = await readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

async function listFilesRec(root) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {await walk(p);} else {out.push(p);}
    }
  }
  await walk(root);
  return out;
}

async function comparePaths(src, dst, type) {
  const diffs = [];
  const onlySrc = [];
  const onlyDst = [];

  if (type === 'file') {
    const srcOk = await exists(src);
    const dstOk = await exists(dst);
    if (!srcOk && !dstOk) {return { diffs, onlySrc, onlyDst };}
    if (srcOk && !dstOk) { onlySrc.push(dst); return { diffs, onlySrc, onlyDst }; }
    if (!srcOk && dstOk) { onlyDst.push(dst); return { diffs, onlySrc, onlyDst }; }
    const [a, b] = await Promise.all([sha256File(src), sha256File(dst)]);
    if (a !== b) {diffs.push(dst);}
    return { diffs, onlySrc, onlyDst };
  }

  const srcOk = await exists(src);
  const dstOk = await exists(dst);
  if (!srcOk && !dstOk) {return { diffs, onlySrc, onlyDst };}
  if (srcOk && !dstOk) {
    const files = await listFilesRec(src);
    onlySrc.push(...files.map(f => f.replace(src, dst)));
    return { diffs, onlySrc, onlyDst };
  }
  if (!srcOk && dstOk) {
    const files = await listFilesRec(dst);
    onlyDst.push(...files);
    return { diffs, onlySrc, onlyDst };
  }

  const srcFiles = await listFilesRec(src);
  const dstFiles = await listFilesRec(dst);
  const srcRel = new Map(srcFiles.map(p => [p.slice(src.length + 1), p]));
  const dstRel = new Map(dstFiles.map(p => [p.slice(dst.length + 1), p]));

  for (const [rel, pSrc] of srcRel) {
    const pDst = dstRel.get(rel);
    if (!pDst) { onlySrc.push(join(dst, rel)); continue; }
    const [a, b] = await Promise.all([sha256File(pSrc), sha256File(pDst)]);
    if (a !== b) {diffs.push(pDst);}
  }
  for (const [rel, pDst] of dstRel) {
    if (!srcRel.has(rel)) {onlyDst.push(pDst);}
  }
  return { diffs, onlySrc, onlyDst };
}

function parseArgs(argv) {
  const args = [...argv];
  const flags = new Set();
  const kv = new Map();
  const positional = [];

  for (const a of args) {
    if (a === '--') {break;}
    if (a.startsWith('--')) {
      const [k, v] = a.split('=', 2);
      if (v === undefined) {flags.add(k);}
      else {kv.set(k, v);}
    } else {
      positional.push(a);
    }
  }

  const help = flags.has('--help') || flags.has('-h');
  const version = flags.has('--version') || flags.has('-v');
  const check = flags.has('--check');
  const force = flags.has('--force');
  const verbose = flags.has('--verbose');
  const json = flags.has('--json');
  const dryRun = flags.has('--dry-run');
  const ciOnly = flags.has('--ci-only');
  const list = flags.has('--list');
  const timeoutMs = Number(kv.get('--timeout') ?? process.env.KB_DEVKIT_SYNC_TIMEOUT_MS ?? 30000);
  const onlyList = kv.get('--only')?.split(',').map(s => s.trim()).filter(Boolean) ?? [];

  const scopeRaw = (kv.get('--scope') ?? process.env.KB_DEVKIT_SYNC_SCOPE ?? '').toString();
  const scope = ['managed-only', 'strict', 'all'].includes(scopeRaw) ? scopeRaw : 'managed-only';

  return { help, version, check, force, verbose, json, dryRun, ciOnly, list, timeoutMs, onlyList, positional, scope };
}

async function readProjectConfig(root) {
  const p = resolve(root, 'kb-labs.config.json');
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return {}; }
}

function resolveTargets(effectiveMap, { onlyList, positional, disabledSet }) {
  const all = Object.keys(effectiveMap).filter(k => !disabledSet.has(k));
  if (onlyList.length === 0 && positional.length === 0) {return all;}
  const requested = [...onlyList, ...positional].filter(Boolean);
  return requested.filter(k => effectiveMap[k] && !disabledSet.has(k));
}

async function writeProvenance(root, { items = [], scope = 'managed-only', report = null, fileName = 'DEVKIT_SYNC.json' } = {}) {
  const meta = await readDevkitMeta();
  await mkdir(resolve(root, '.kb/devkit/tmp'), { recursive: true });
  const payload = {
    source: meta.name,
    version: meta.version,
    when: nowIso(),
    scope,
    items,
  };
  if (report) {payload.report = report;}
  await writeFile(resolve(root, `.kb/devkit/tmp/${fileName}`), JSON.stringify(payload, null, 2));
}

async function runCheck(root, effectiveMap, targets, { verbose, scope }) {
  const details = [];
  const summary = { ok: 0, drift: 0 };
  const considerOnlyDst = scope !== 'managed-only';
  const checkTargets = [];

  for (const key of targets) {
    const { from, to, type } = effectiveMap[key];
    const dst = to(root);
    const res = await comparePaths(from, dst, type === 'hooks' ? 'dir' : type);

    const changed = (res.diffs.length + res.onlySrc.length + (considerOnlyDst ? res.onlyDst.length : 0)) > 0;
    const item = {
      key,
      type,
      dst,
      diffs: res.diffs,
      onlySrc: res.onlySrc,
      onlyDst: considerOnlyDst ? res.onlyDst : [],
    };
    if (!considerOnlyDst && res.onlyDst.length) {
      item.ignored = { onlyDst: res.onlyDst.length };
    }

    const files = [];
    async function addChangedWithHashes(pDstAbs) {
      const rel = pDstAbs.startsWith(dst) ? pDstAbs.slice(dst.length + 1) : null;
      const pSrcAbs = rel ? join(from, rel) : null;
      let hashSrc = null, hashDst = null;
      try { hashDst = await sha256File(pDstAbs); } catch { }
      if (pSrcAbs) { try { hashSrc = await sha256File(pSrcAbs); } catch { } }
      files.push({
        fromPath: rel ? relFromDevkit(pSrcAbs) : null,
        toPath: relFromRepo(root, pDstAbs),
        action: 'changed',
        hashBefore: hashDst,
        hashAfter: hashSrc
      });
    }
    for (const p of res.diffs) { await addChangedWithHashes(p); }
    for (const p of res.onlySrc) {
      const rel = p.startsWith(dst) ? p.slice(dst.length + 1) : null;
      const pSrcAbs = rel ? join(from, rel) : null;
      let hashSrc = null; try { if (pSrcAbs) {hashSrc = await sha256File(pSrcAbs);} } catch { }
      files.push({
        fromPath: rel ? relFromDevkit(pSrcAbs) : null,
        toPath: relFromRepo(root, p),
        action: 'missing-dst',
        hashBefore: null,
        hashAfter: hashSrc
      });
    }
    if (considerOnlyDst) {
      for (const p of res.onlyDst) {
        let hashDst = null; try { hashDst = await sha256File(p); } catch { }
        files.push({
          fromPath: null,
          toPath: relFromRepo(root, p),
          action: 'foreign',
          hashBefore: hashDst,
          hashAfter: null
        });
      }
    }
    const tStatus = (res.diffs.length || res.onlySrc.length || (considerOnlyDst ? res.onlyDst.length : 0)) ? 'drift' : 'ok';
    checkTargets.push({ id: key, status: tStatus, files });

    details.push(item);
    if (changed) {
      summary.drift++;
      log(`drift ${key}:`, JSON.stringify(item, null, 2));
    } else {
      summary.ok++;
      if (verbose) {log(`ok ${key}: no drift`);}
    }
  }
  log('check done', summary);

  const meta = await readDevkitMeta();
  const report = {
    schemaVersion: '2-min',
    devkit: { version: meta.version, commit: meta.commit },
    repo: {},
    run: { id: cryptoRandomId(), startedAt: null, finishedAt: null },
    summary: { filesChanged: summary.drift, kept: summary.ok, skipped: 0, conflicts: 0, mode: 'check', driftCount: summary.drift },
    targets: checkTargets
  };
  await writeProvenance(root, { items: checkTargets.map(t => t.id), scope, report, fileName: 'DEVKIT_CHECK.json' });
  log('check report written to', '.kb/devkit/tmp/DEVKIT_CHECK.json');

  return { code: summary.drift > 0 ? 2 : 0, summary, details };
}

async function runSync(root, effectiveMap, targets, { force, verbose, dryRun }) {
  const details = [];
  const startedAt = Date.now();
  const reportTargets = [];
  let filesChanged = 0, keptCount = 0, skippedCount = 0;
  const summary = { synced: 0, kept: 0, skipped: 0 };

  for (const key of targets) {
    const { from, to, type } = effectiveMap[key];
    const dst = to(root);
    const tReport = { id: key, status: 'pending', why: [], files: [] };

    const srcOk = await exists(from);
    if (!srcOk) {
      summary.skipped++;
      details.push({ key, action: 'skip', reason: 'source-missing', from, dst });
      warn(`skip ${key} — source not found: ${from}`);
      tReport.status = 'skipped';
      reportTargets.push(tReport);
      continue;
    }
    if (!force && await exists(dst)) {
      summary.kept++;
      details.push({ key, action: 'keep', from, dst });
      tReport.status = 'kept';
      if (type === 'file') {
        const h = await sha256File(dst).catch(() => null);
        tReport.files.push({
          fromPath: relFromDevkit(from),
          toPath: relFromRepo(root, dst),
          action: 'keep',
          hashBefore: h,
          hashAfter: h
        });
      }
      keptCount++;
      reportTargets.push(tReport);
      if (verbose) {log(`keep ${key} — exists: ${dst}`);}
      continue;
    }
    if (dryRun) {
      summary.synced++;
      details.push({ key, action: 'plan-sync', from, dst, type });
      tReport.status = 'planned';
      reportTargets.push(tReport);
      log(`[dry-run] ${key} -> ${dst}`);
      continue;
    }
    let filePairs = [];
    if (type === 'file') {
      filePairs = [[from, dst]];
    } else {
      const srcFiles = await listFilesRec(from);
      filePairs = srcFiles.map(sf => {
        const rel = sf.slice(from.length + 1);
        return [sf, join(dst, rel)];
      });
    }
    const isHooks = type === 'hooks';
    const beforeState = await Promise.all(filePairs.map(async ([srcFile, dstFile]) => {
      const existed = await exists(dstFile);
      const hb = existed ? await sha256File(dstFile).catch(() => null) : null;
      return { srcFile, dstFile, existed, hashBefore: hb };
    }));

    if (type === 'file') {await ensureDirForFile(dst);} else {await mkdir(dst, { recursive: true });}
    await cp(from, dst, { recursive: true, force: true });

    const afterState = await Promise.all(beforeState.map(async (s) => {
      const ha = await sha256File(s.dstFile).catch(() => null);
      const action = s.existed ? ((s.hashBefore && ha && s.hashBefore === ha) ? 'keep' : 'update') : 'create';
      if (action !== 'keep') {filesChanged++;}
      tReport.files.push({
        fromPath: relFromDevkit(s.srcFile),
        toPath: relFromRepo(root, s.dstFile),
        action,
        hashBefore: s.hashBefore ?? null,
        hashAfter: ha ?? null
      });
      return { ...s, hashAfter: ha, action };
    }));
    const created = afterState.filter(s => s.action === 'create').length;
    const updated = afterState.filter(s => s.action === 'update').length;
    const keptF = afterState.filter(s => s.action === 'keep').length;
    tReport.status = 'applied';
    reportTargets.push(tReport);
    summary.synced++;
    details.push({ key, action: 'synced', from, dst, type });
    log(`→ ${key}: ${created} created, ${updated} updated, ${keptF} kept`);
    log(`synced ${key} -> ${dst}`);

    // For hooks: also install into .git/hooks/ and chmod +x
    if (isHooks) {
      const gitHooksDir = resolve(root, '.git', 'hooks');
      const gitDirExists = await exists(resolve(root, '.git'));
      if (gitDirExists) {
        await mkdir(gitHooksDir, { recursive: true });
        for (const [, dstFile] of filePairs) {
          const hookName = dstFile.slice(dst.length + 1);
          const gitHookDst = join(gitHooksDir, hookName);
          await cp(dstFile, gitHookDst, { force: true });
          await chmod(gitHookDst, 0o755);
        }
        log(`hooks installed into .git/hooks/`);
      } else {
        warn(`skip .git/hooks install — no .git directory found at ${root}`);
      }
    }
  }
  const finishedAt = Date.now();
  log('sync done', summary, `(force=${force}, dry-run=${!!dryRun})`);
  return {
    code: 0,
    summary,
    details,
    _report: {
      targets: reportTargets,
      filesChanged,
      keptCount,
      skippedCount,
      startedAt,
      finishedAt
    }
  };
}

/**
 * Generates tsconfig.build.json for all packages with tsup.config.ts
 * This ensures tsup uses a tsconfig without paths to prevent bundling workspace packages
 */
async function generateTsconfigBuild(root, { dryRun, verbose }) {
  const tsupConfigs = await glob('**/tsup.config.ts', {
    cwd: root,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.kb/**'],
    absolute: false,
  });

  if (tsupConfigs.length === 0) {
    if (verbose) {log('No tsup.config.ts files found, skipping tsconfig.build.json generation');}
    return { generated: 0, skipped: 0 };
  }

  let generated = 0;
  let skipped = 0;

  for (const tsupConfigPath of tsupConfigs) {
    const pkgDir = dirname(resolve(root, tsupConfigPath));
    const tsconfigPath = join(pkgDir, 'tsconfig.json');
    const tsconfigBuildPath = join(pkgDir, 'tsconfig.build.json');

    // Check if tsconfig.json exists
    const tsconfigExists = await exists(tsconfigPath);
    if (!tsconfigExists) {
      if (verbose) {log(`Skipping ${tsupConfigPath}: no tsconfig.json found`);}
      skipped++;
      continue;
    }

    // Read existing tsconfig.json to determine base path
    let tsconfigBase;
    try {
      const tsconfigContent = await readFile(tsconfigPath, 'utf8');
      tsconfigBase = JSON.parse(tsconfigContent);
    } catch (error) {
      if (verbose) {warn(`Failed to parse ${tsconfigPath}:`, error.message);}
      skipped++;
      continue;
    }

    // Determine relative path to tsconfig.base.json
    // Common patterns: "../../tsconfig.base.json", "../tsconfig.base.json", "./tsconfig.base.json"
    let basePath = tsconfigBase.extends;
    if (Array.isArray(basePath)) {
      // Find the first non-devkit extends (usually tsconfig.base.json)
      basePath = basePath.find(p => typeof p === 'string' && !p.includes('@kb-labs/devkit')) || basePath[0];
    }
    if (typeof basePath !== 'string') {
      // Default: search up for tsconfig.base.json
      let current = pkgDir;
      let found = false;
      for (let i = 0; i < 10; i++) {
        const candidate = join(current, 'tsconfig.base.json');
        if (await exists(candidate)) {
          basePath = relativeTsconfigPath(pkgDir, candidate);
          found = true;
          break;
        }
        const parent = dirname(current);
        if (parent === current) {break;}
        current = parent;
      }
      if (!found) {
        // Fallback to common pattern
        const depth = relative(root, pkgDir).split(/[/\\]/).filter(Boolean).length;
        basePath = '../'.repeat(depth) + 'tsconfig.base.json';
      }
    }

    // Normalize basePath to relative path
    if (basePath.includes('@kb-labs/devkit')) {
      // If extends devkit, try to find tsconfig.base.json in repo root
      let current = pkgDir;
      for (let i = 0; i < 10; i++) {
        const candidate = join(current, 'tsconfig.base.json');
        if (await exists(candidate)) {
          basePath = relativeTsconfigPath(pkgDir, candidate);
          break;
        }
        const parent = dirname(current);
        if (parent === current) {break;}
        current = parent;
      }
    }

    // Generate tsconfig.build.json content
    const buildConfig = {
      extends: basePath,
      compilerOptions: {
        outDir: 'dist',
        baseUrl: '.',
        paths: {},
      },
      include: ['src/**/*'],
      exclude: ['dist', 'node_modules'],
    };

    // Check if file already exists and is identical
    const existingExists = await exists(tsconfigBuildPath);
    if (existingExists && !dryRun) {
      try {
        const existingContent = await readFile(tsconfigBuildPath, 'utf8');
        const existing = JSON.parse(existingContent);
        // Compare key fields
        if (
          existing.extends === buildConfig.extends &&
          JSON.stringify(existing.compilerOptions?.paths) === JSON.stringify(buildConfig.compilerOptions.paths)
        ) {
          if (verbose) {log(`Keep ${tsconfigBuildPath}: already up to date`);}
          skipped++;
          continue;
        }
      } catch {
        // If parse fails, regenerate
      }
    }

    if (dryRun) {
      log(`[dry-run] Would generate ${tsconfigBuildPath}`);
      generated++;
      continue;
    }

    // Write tsconfig.build.json
    try {
      await writeFile(tsconfigBuildPath, JSON.stringify(buildConfig, null, 2) + '\n');
      log(`Generated ${tsconfigBuildPath}`);
      generated++;
    } catch (error) {
      warn(`Failed to write ${tsconfigBuildPath}:`, error.message);
      skipped++;
    }
  }

  return { generated, skipped };
}

function printHelp(effectiveMap = BASE_MAP) {
  const keys = Object.keys(effectiveMap).join(', ');
  console.log(`kb-devkit-sync
Synchronize DevKit assets into a consumer repository.

Usage:
  kb-devkit-sync [--check] [--force] [--dry-run] [--verbose] [--json] [--timeout=ms] [--scope=managed-only|strict|all] [--only=a,b] [targets...]

Targets:
  ${keys}
  (Override/add via kb-labs.config.json → { "sync": { "overrides": {..}, "targets": {..}, "only": ["ci"], "disabled": ["sbom"], "scope": "managed-only" } })

Flags:
  --help, -h        Show this help and exit
  --version, -v     Print devkit version and exit
  --list            Print available target keys and exit
  --check           Compare and exit with 0 (no drift) or 2 (drift found)
  --force           Overwrite destination files/directories
  --dry-run         Do not write files; print planned actions
  --ci-only         Limit scope to CI templates (alias for --only=ci)
  --scope=...       Set drift scope: 'managed-only' (ignore foreign files, default), 'strict' (flag foreign files), 'all'
  --verbose         Print per-target details
  --json            Emit machine-readable JSON result to stdout
  --timeout=ms      Optional timeout guard (default 30000)
  --only=a,b        Limit sync/check to specific targets
`);
}

async function printVersion() {
  try {
    const pkgJson = JSON.parse(await readFile(resolve(DEVKIT_ROOT, 'package.json'), 'utf8'));
    console.log(pkgJson.version ?? 'unknown');
  } catch {
    console.log('unknown');
  }
}

export async function run({ args = [] } = {}) {
  const { help, version, check, force, verbose, json, dryRun, ciOnly, list, timeoutMs, onlyList, positional, scope: scopeFromCli } = parseArgs(args);
  const devkitMeta = await readDevkitMeta();
  log(`DevKit ${devkitMeta.version ?? 'unknown'} — scope=${(process.env.KB_DEVKIT_SYNC_SCOPE || '').toString() || 'managed-only'}`);
  const root = process.cwd();
  const cfg = await readProjectConfig(root);

  if (cfg?.sync?.enabled === false) {
    log('sync disabled by kb-labs.config.json');
    return 0;
  }

  const disabledSet = new Set(cfg?.sync?.disabled ?? []);
  const map = buildEffectiveMap(cfg);

  if (list) {
    console.log('[devkit-sync] available targets:', Object.keys(map).join(', '));
    return 0;
  }

  const cfgOnly = Array.isArray(cfg?.sync?.only) ? cfg.sync.only.filter(s => typeof s === 'string' && s.length > 0) : [];
  let select = onlyList.length ? onlyList.slice() : cfgOnly.slice();

  if (ciOnly) {
    const hasCi = select.includes('ci') || positional.includes('ci');
    if (!hasCi) {
      if (select.length === 0 && positional.length === 0) {select = ['ci'];}
      else {select.push('ci');}
    }
  }

  const seen = new Set();
  select = select.filter(k => (k && !seen.has(k) && seen.add(k)));

  const pos = positional.filter(Boolean);
  const targets = resolveTargets(map, { onlyList: select, positional: pos, disabledSet });

  log(`Targets: [${targets.join(', ')}]`);

  let scope = scopeFromCli || cfg?.sync?.scope || 'managed-only';
  if (!['managed-only', 'strict', 'all'].includes(scope)) {scope = 'managed-only';}

  if (help) { printHelp(map); return 0; }
  if (version) { await printVersion(); return 0; }

  const controller = new AbortController();
  const t = setTimeout(() => { controller.abort(); }, Math.max(0, timeoutMs));

  try {
    log('Starting devkit sync...');
    if (check) {
      const res = await runCheck(root, map, targets, { verbose, scope });
      if (json) {console.log(JSON.stringify({ mode: 'check', ...res }, null, 2));}
      return res.code;
    } else {
      const res = await runSync(root, map, targets, { force: force || !!cfg?.sync?.force, verbose, dryRun });
      
      // Generate tsconfig.build.json for all packages with tsup.config.ts
      // This is done after sync to ensure proper bundling configuration
      if (!dryRun || verbose) {
        const buildResult = await generateTsconfigBuild(root, { dryRun, verbose });
        if (buildResult.generated > 0 || buildResult.skipped > 0) {
          log(`tsconfig.build.json: ${buildResult.generated} generated, ${buildResult.skipped} skipped`);
        }
      }
      
      const report = {
        schemaVersion: '2-min',
        devkit: { version: devkitMeta.version, commit: devkitMeta.commit },
        repo: {},
        run: {
          id: cryptoRandomId(),
          startedAt: new Date(res?._report?.startedAt ?? Date.now()).toISOString(),
          finishedAt: new Date(res?._report?.finishedAt ?? Date.now()).toISOString()
        },
        summary: {
          filesChanged: res?._report?.filesChanged ?? 0,
          kept: res.summary.kept,
          skipped: res.summary.skipped,
          conflicts: 0,
          mode: 'sync'
        },
        targets: (res?._report?.targets ?? [])
      };
      await writeProvenance(root, { items: targets, scope, report, fileName: 'DEVKIT_SYNC.json' });
      if (json) {console.log(JSON.stringify({ mode: 'sync', ...res }, null, 2));}
      return res.code;
    }
  } finally {
    clearTimeout(t);
  }
}
