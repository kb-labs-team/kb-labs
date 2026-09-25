/**
 * Tests for the boundary / naming lints (tasks 0.2, 0.3, 0.5).
 * Run: node --test scripts/checks/boundary-lints.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyExceptions, loadExceptions } from './lib/boundary-common.mjs';
import { collect as collectImports, findCoreImports } from './check-plugin-imports.mjs';
import { collect as collectSpawns, findPlatformBinarySpawns } from './check-platform-spawn.mjs';
import { collect as collectPeer, findPlatformRuntimeDeps, isPlatformPackage } from './check-plugin-peer-deps.mjs';
import { collect as collectManifests, RULES, validateManifest } from './check-manifest-command-naming.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const tmpRoots = [];

function fixtureRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'kb-boundary-lint-'));
  tmpRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

/** package.json + manifest source that make a package a real plugin entry package. */
function pluginEntry(dir, name, pkgExtra = {}) {
  return {
    [`${dir}/package.json`]: { name, kb: { manifest: './dist/manifest.js' }, ...pkgExtra },
    [`${dir}/src/manifest.ts`]: `export const manifest = { schema: 'kb.plugin/3', id: '${name}' };\n`,
  };
}

after(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

function runScript(script, args) {
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], { encoding: 'utf-8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// ─── 0.2(a) plugin imports ───────────────────────────────────────────────────

describe('plugin-imports (0.2a)', () => {
  test('detects static, re-export, dynamic and require forms; ignores sdk, relative and comments', () => {
    const src = `
      import { a } from '@kb-labs/core-platform';
      import type { B } from "@kb-labs/core-runtime/sub/path";
      export * from '@kb-labs/core-config';
      const c = await import('@kb-labs/core-sys');
      const d = require('@kb-labs/core-registry');
      import { ok } from '@kb-labs/sdk';
      import { rel } from './core-platform';
      // import { nope } from '@kb-labs/core-commented';
      /* import x from '@kb-labs/core-block'; */
      import { own } from '@kb-labs/commit-core';
    `;
    assert.deepEqual(findCoreImports(src).sort(), [
      '@kb-labs/core-config',
      '@kb-labs/core-platform',
      '@kb-labs/core-registry',
      '@kb-labs/core-runtime',
      '@kb-labs/core-sys',
    ]);
  });

  test('failing fixture: plugin source importing core-* is reported; tests and sdk imports are not', () => {
    const root = fixtureRepo({
      ...pluginEntry('plugins/bad/entry', '@kb-labs/bad-entry'),
      'plugins/bad/entry/src/index.ts': `import { platform } from '@kb-labs/core-platform';\nexport const x = platform;\n`,
      'plugins/bad/entry/src/index.test.ts': `import { platform } from '@kb-labs/core-platform';\n`,
      ...pluginEntry('plugins/good/entry', '@kb-labs/good-entry'),
      'plugins/good/entry/src/index.ts': `import { platform } from '@kb-labs/sdk';\n`,
      // platform parts under plugins/ (no kb.plugin/3 manifest) are out of scope
      'plugins/bad/daemon/package.json': { name: '@kb-labs/bad-daemon', kb: { manifest: './dist/manifest.js' } },
      'plugins/bad/daemon/src/manifest.ts': `export const manifest = { schema: 'kb.plugin/2' };\n`,
      'plugins/bad/daemon/src/index.ts': `import { platform } from '@kb-labs/core-platform';\n`,
      'plugins/bad/engine/package.json': { name: '@kb-labs/bad-engine' },
      'plugins/bad/engine/src/index.ts': `import { platform } from '@kb-labs/core-platform';\n`,
    });
    const v = collectImports(root);
    assert.equal(v.length, 1);
    assert.equal(v[0].package, 'plugins/bad/entry');
    assert.equal(v[0].target, '@kb-labs/core-platform');
    assert.equal(v[0].rule, 'plugin-core-import');
    assert.equal(v[0].file, 'plugins/bad/entry/src/index.ts');
  });

  test('CLI exits 1 on a new violation and 0 once it is in the exceptions file', () => {
    const root = fixtureRepo({
      ...pluginEntry('plugins/bad/entry', '@kb-labs/bad-entry'),
      'plugins/bad/entry/src/index.ts': `import x from '@kb-labs/core-contracts';\n`,
      'ex-empty.json': { version: 1, exceptions: [] },
      'ex-full.json': {
        version: 1,
        exceptions: [
          { rule: 'plugin-core-import', package: 'plugins/bad/entry', target: '@kb-labs/core-contracts', since: '2026-09-26', reason: 'fixture' },
        ],
      },
    });
    const bad = runScript('check-plugin-imports.mjs', ['--root', root, '--exceptions', join(root, 'ex-empty.json')]);
    assert.equal(bad.code, 1, bad.err);
    assert.match(bad.err, /imports @kb-labs\/core-contracts directly/);
    const ok = runScript('check-plugin-imports.mjs', ['--root', root, '--exceptions', join(root, 'ex-full.json')]);
    assert.equal(ok.code, 0, ok.err);
  });
});

// ─── 0.2(b) platform binary spawn ────────────────────────────────────────────

describe('platform-spawn (0.2b)', () => {
  const cp = `import { spawn, execSync } from 'node:child_process';\n`;

  test('detects platform binaries in spawn / exec / execFile / execa / fork calls', () => {
    assert.deepEqual(findPlatformBinarySpawns(cp + `spawn('kb-create', ['update']);`), ['kb-create']);
    assert.deepEqual(findPlatformBinarySpawns(cp + `execSync('kb-dev status');`), ['kb-dev']);
    assert.deepEqual(findPlatformBinarySpawns(cp + `execSync('./tools/kb-devkit/kb-devkit run build');`), ['kb-devkit']);
    assert.deepEqual(findPlatformBinarySpawns(cp + `spawn('pnpm', ['kb', 'plugin', 'list']);`), ['kb']);
    assert.deepEqual(findPlatformBinarySpawns(cp + `execSync('pnpm kb logs query');`), ['kb']);
    assert.deepEqual(findPlatformBinarySpawns(cp + `spawn(process.execPath, ['cli/bin/dist/bin.js', 'x']);`), ['kb']);
    assert.deepEqual(
      findPlatformBinarySpawns(`import { execa } from 'execa';\nawait execa('/usr/local/bin/kb', ['status']);`),
      ['kb'],
    );
    assert.deepEqual(
      findPlatformBinarySpawns(`import * as childProcess from 'child_process';\nchildProcess.execFile('kb', []);`),
      ['kb'],
    );
  });

  test('does not flag other binaries, regex.exec, commented code, or files without child_process', () => {
    assert.deepEqual(findPlatformBinarySpawns(cp + `spawn('git', ['status']);`), []);
    assert.deepEqual(findPlatformBinarySpawns(cp + `spawn('kbd-tool', []);`), []);
    assert.deepEqual(findPlatformBinarySpawns(cp + `const m = /x/.exec('kb status');`), []);
    assert.deepEqual(findPlatformBinarySpawns(cp + `// spawn('kb', [])\nspawn('git', []);`), []);
    assert.deepEqual(findPlatformBinarySpawns(`const s = spawn('kb', []);`), []);
  });

  test('failing fixture: only services/*, studio/* and plugins/*/daemon are in scope', () => {
    const bad = `import { spawn } from 'node:child_process';\nspawn('kb-dev', ['start']);\n`;
    const root = fixtureRepo({
      'services/svc/app/package.json': { name: '@kb-labs/svc-app' },
      'services/svc/app/src/run.ts': bad,
      'studio/backend/package.json': { name: '@kb-labs/studio-backend' },
      'studio/backend/src/run.ts': bad,
      'plugins/p/daemon/package.json': { name: '@kb-labs/p-daemon' },
      'plugins/p/daemon/src/run.ts': bad,
      'plugins/p/entry/package.json': { name: '@kb-labs/p-entry' }, // CLI entry: out of scope
      'plugins/p/entry/src/run.ts': bad,
      'services/svc/app/src/run.test.ts': bad, // tests ignored
    });
    const v = collectSpawns(root);
    assert.deepEqual(
      v.map((x) => x.package).sort(),
      ['plugins/p/daemon', 'services/svc/app', 'studio/backend'],
    );
    assert.ok(v.every((x) => x.rule === 'platform-binary-spawn' && x.target === 'kb-dev'));
  });

  test('CLI exits 1 on a spawn violation', () => {
    const root = fixtureRepo({
      'services/svc/app/package.json': { name: '@kb-labs/svc-app' },
      'services/svc/app/src/run.ts': `import { exec } from 'node:child_process';\nexec('kb-create update');\n`,
      'ex.json': { version: 1, exceptions: [] },
    });
    const r = runScript('check-platform-spawn.mjs', ['--root', root, '--exceptions', join(root, 'ex.json')]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /spawns the platform binary "kb-create"/);
  });
});

// ─── 0.3 peerDependencies ────────────────────────────────────────────────────

describe('plugin-peer-deps (0.3)', () => {
  test('classifies platform vs plugin-own packages', () => {
    for (const n of ['@kb-labs/sdk', '@kb-labs/core-platform', '@kb-labs/plugin-contracts', '@kb-labs/plugin-runtime', '@kb-labs/shared-cli-ui', '@kb-labs/cli-runtime', '@kb-labs/adapters-fs']) {
      assert.equal(isPlatformPackage(n), true, n);
    }
    for (const n of ['@kb-labs/commit-core', '@kb-labs/agent-sdk', '@kb-labs/workflow-runtime', 'zod', '@kb-labs/devkit']) {
      assert.equal(isPlatformPackage(n), false, n);
    }
  });

  test('failing fixture: platform package under dependencies; peer + dev entries pass', () => {
    assert.deepEqual(
      findPlatformRuntimeDeps({ dependencies: { '@kb-labs/sdk': 'workspace:*', zod: '^3' }, optionalDependencies: { '@kb-labs/core-sys': '*' } }),
      [
        { target: '@kb-labs/sdk', field: 'dependencies' },
        { target: '@kb-labs/core-sys', field: 'optionalDependencies' },
      ],
    );
    assert.deepEqual(
      findPlatformRuntimeDeps({
        dependencies: { '@kb-labs/commit-core': 'workspace:*' },
        peerDependencies: { '@kb-labs/sdk': 'workspace:*' },
        devDependencies: { '@kb-labs/sdk': 'workspace:*', '@kb-labs/core-runtime': 'workspace:*' },
      }),
      [],
    );
  });

  test('scans plugins/* and templates/plugin-template packages', () => {
    const root = fixtureRepo({
      ...pluginEntry('plugins/bad/entry', '@kb-labs/bad-entry', { dependencies: { '@kb-labs/sdk': 'workspace:*' } }),
      ...pluginEntry('plugins/good/entry', '@kb-labs/good-entry', { peerDependencies: { '@kb-labs/sdk': '*' }, devDependencies: { '@kb-labs/sdk': 'workspace:*' } }),
      // platform parts under plugins/ (daemon, engine) are out of scope
      'plugins/bad/daemon/package.json': { name: '@kb-labs/bad-daemon', dependencies: { '@kb-labs/core-platform': 'workspace:*' } },
      'templates/plugin-template/packages/core/package.json': { name: 'tpl-core', dependencies: { '@kb-labs/plugin-contracts': 'workspace:*' } },
      'templates/other/package.json': { name: 'other', dependencies: { '@kb-labs/sdk': 'workspace:*' } },
    });
    const v = collectPeer(root);
    assert.deepEqual(
      v.map((x) => `${x.package} ${x.target}`).sort(),
      ['plugins/bad/entry @kb-labs/sdk', 'templates/plugin-template/packages/core @kb-labs/plugin-contracts'],
    );
  });

  test('CLI exits 1 on a new offender', () => {
    const root = fixtureRepo({
      ...pluginEntry('plugins/bad/entry', '@kb-labs/bad-entry', { dependencies: { '@kb-labs/sdk': 'workspace:*' } }),
      'ex.json': { version: 1, exceptions: [] },
    });
    const r = runScript('check-plugin-peer-deps.mjs', ['--root', root, '--exceptions', join(root, 'ex.json')]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /must be peerDependencies/);
  });

  test('the real plugin template passes with no exception', () => {
    const repoRoot = join(HERE, '..', '..');
    const fromTemplate = collectPeer(repoRoot).filter((v) => v.package.startsWith('templates/'));
    assert.deepEqual(fromTemplate, []);
  });
});

// ─── 0.5 command naming ──────────────────────────────────────────────────────

const manifest = (commands) => ({ schema: 'kb.plugin/3', id: '@kb-labs/x', cli: { commands } });

describe('manifest-command-naming (0.5)', () => {
  test('accepts vocabulary verbs, kebab segments and single-segment namespace commands', () => {
    const v = validateManifest(
      manifest([
        { path: 'foo' },
        { path: 'foo list' },
        { path: 'foo bar-baz show' },
        { path: 'foo item delete', operationType: 'mutate', flags: [{ name: 'json', type: 'boolean' }] },
      ]),
    );
    assert.deepEqual(v, []);
  });

  test('failing fixture: verb outside the vocabulary', () => {
    const v = validateManifest(manifest([{ path: 'foo frobnicate' }]));
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, 'command-verb-vocabulary');
    assert.equal(v[0].target, 'foo frobnicate');
  });

  test('failing fixture: path segments must be lowercase kebab-case', () => {
    const rules = (p) => validateManifest(manifest([{ path: p }])).map((x) => x.rule);
    assert.ok(rules('foo Bar list').includes('command-path-case'));
    assert.ok(rules('foo bar_baz list').includes('command-path-case'));
    assert.ok(rules('foo bar--baz list').includes('command-path-case'));
    assert.ok(rules('Foo list').includes('command-path-case'));
    assert.ok(!rules('foo bar-baz list').includes('command-path-case'));
  });

  test("failing fixture: 'mutate' commands must declare --json (array and object flag shapes)", () => {
    const missing = validateManifest(manifest([{ path: 'foo delete', operationType: 'mutate', flags: [{ name: 'yes' }] }]));
    assert.deepEqual(missing.map((x) => x.rule), ['mutate-json-flag']);
    const noFlags = validateManifest(manifest([{ path: 'foo delete', operationType: 'mutate' }]));
    assert.deepEqual(noFlags.map((x) => x.rule), ['mutate-json-flag']);
    // read/analyze commands are not required to declare --json
    assert.deepEqual(validateManifest(manifest([{ path: 'foo list', operationType: 'read' }])), []);
    // --dry-run is injected by the registry for 'mutate', so its absence is not a violation
    assert.deepEqual(
      validateManifest(manifest([{ path: 'foo delete', operationType: 'mutate', flags: [{ name: 'json' }] }])),
      [],
    );
    assert.deepEqual(
      validateManifest(manifest([{ path: 'foo delete', operationType: 'mutate', flags: { json: { type: 'boolean' } } }])),
      [],
    );
  });

  test("operationType accepts read/mutate/analyze/execute, rejects anything else", () => {
    for (const t of ['read', 'analyze', 'execute']) {
      assert.deepEqual(validateManifest(manifest([{ path: 'foo run', operationType: t }])), [], t);
    }
    const bad = validateManifest(manifest([{ path: 'foo run', operationType: 'write' }]));
    assert.deepEqual(bad.map((x) => x.rule), ['command-operation-type']);
  });

  test('ignores non kb.plugin/3 manifests', () => {
    assert.deepEqual(validateManifest({ schema: 'kb.plugin/2', cli: { commands: [{ path: 'Foo Bad' }] } }), []);
  });

  test('collect reads dist manifest.json of plugin packages; unbuilt packages warn', () => {
    const root = fixtureRepo({
      'plugins/p/entry/package.json': { name: '@kb-labs/p-entry', kb: { manifest: './dist/manifest.js' } },
      'plugins/p/entry/dist/manifest.json': manifest([{ path: 'p frobnicate' }]),
      ...pluginEntry('plugins/q/entry', '@kb-labs/q-entry'),
      'plugins/r/core/package.json': { name: '@kb-labs/r-core' }, // no kb.manifest: ignored
    });
    const v = collectManifests(root);
    assert.deepEqual(
      v.map((x) => `${x.package} ${x.rule}`).sort(),
      ['(workspace) manifest-not-built', 'plugins/p/entry command-verb-vocabulary'],
    );
    const notBuilt = v.find((x) => x.rule === 'manifest-not-built');
    assert.equal(notBuilt.severity, 'warning');
    assert.deepEqual(notBuilt.unscanned, ['plugins/q/entry']);
  });

  test('an unbuilt package does not make its exceptions stale, a built one does', () => {
    const exFor = (pkg) => ({ rule: 'command-verb-vocabulary', package: pkg, target: 'q gone', since: '2026-09-26', reason: 'fixture' });
    const root = fixtureRepo({
      'plugins/p/entry/package.json': { name: '@kb-labs/p-entry', kb: { manifest: './dist/manifest.js' } },
      'plugins/p/entry/dist/manifest.json': manifest([{ path: 'p list' }]),
      ...pluginEntry('plugins/q/entry', '@kb-labs/q-entry'),
    });
    const { stale } = applyExceptions(collectManifests(root), [exFor('plugins/p/entry'), exFor('plugins/q/entry')], RULES);
    assert.deepEqual(stale.map((e) => e.package), ['plugins/p/entry']);
  });

  test('CLI exits 1 on a naming violation, 0 with an exception', () => {
    const root = fixtureRepo({
      'plugins/p/entry/package.json': { name: '@kb-labs/p-entry', kb: { manifest: './dist/manifest.js' } },
      'plugins/p/entry/dist/manifest.json': manifest([{ path: 'p frobnicate' }]),
      'ex-empty.json': { version: 1, exceptions: [] },
      'ex-full.json': {
        version: 1,
        exceptions: [{ rule: 'command-verb-vocabulary', package: 'plugins/p/entry', target: 'p frobnicate', since: '2026-09-26', reason: 'fixture' }],
      },
    });
    assert.equal(runScript('check-manifest-command-naming.mjs', ['--root', root, '--exceptions', join(root, 'ex-empty.json')]).code, 1);
    assert.equal(runScript('check-manifest-command-naming.mjs', ['--root', root, '--exceptions', join(root, 'ex-full.json')]).code, 0);
  });
});

// ─── exceptions mechanism ────────────────────────────────────────────────────

describe('exceptions file', () => {
  const ex = { rule: 'r', package: 'p', target: 't', since: '2026-09-26', reason: 'because' };

  test('matches by rule+package+target, reports stale entries of owned rules only', () => {
    const { blocking, allowed, stale } = applyExceptions(
      [
        { rule: 'r', package: 'p', target: 't' },
        { rule: 'r', package: 'p', target: 'new' },
      ],
      [ex, { ...ex, target: 'gone' }, { ...ex, rule: 'other', target: 'x' }],
      ['r'],
    );
    assert.equal(allowed.length, 1);
    assert.deepEqual(blocking.map((v) => v.target), ['new']);
    assert.deepEqual(stale.map((e) => e.target), ['gone']);
  });

  test('loader rejects entries without reason or with a malformed date', () => {
    const root = fixtureRepo({
      'a.json': { version: 1, exceptions: [{ ...ex, reason: '' }] },
      'b.json': { version: 1, exceptions: [{ ...ex, since: 'yesterday' }] },
    });
    assert.throws(() => loadExceptions(join(root, 'a.json')), /reason/);
    assert.throws(() => loadExceptions(join(root, 'b.json')), /YYYY-MM-DD/);
  });

  test('the committed exceptions file is well-formed and every entry has a date and reason', () => {
    const list = loadExceptions();
    assert.ok(list.length > 0);
    const keys = new Set(list.map((e) => `${e.rule}|${e.package}|${e.target}`));
    assert.equal(keys.size, list.length, 'duplicate exception entries');
  });

  test('devkit mode: non-anchor package gets an empty issue list; anchor gets findings', () => {
    const root = fixtureRepo({
      ...pluginEntry('plugins/bad/entry', '@kb-labs/bad-entry', { dependencies: { '@kb-labs/sdk': 'workspace:*' } }),
      'ex.json': { version: 1, exceptions: [] },
    });
    const run = (pkg) =>
      spawnSync(process.execPath, [join(HERE, 'check-plugin-peer-deps.mjs'), '--root', root, '--exceptions', join(root, 'ex.json')], {
        encoding: 'utf-8',
        env: { ...process.env, KB_DEVKIT_MODE: '1', KB_DEVKIT_PACKAGE_NAME: pkg },
      });
    assert.deepEqual(JSON.parse(run('@kb-labs/other').stdout), { issues: [] });
    const anchored = JSON.parse(run('@kb-labs/devkit').stdout);
    assert.equal(anchored.issues.length, 1);
    assert.equal(anchored.issues[0].severity, 'error');
    assert.equal(anchored.issues[0].check, 'plugin-peer-deps');
  });
});
