#!/usr/bin/env node
/**
 * check-platform-spawn — services, Studio and plugin daemons must not spawn platform
 * binaries (`kb`, `kb-create`, `kb-dev`, `kb-devkit`) as subprocesses.
 *
 * Task 0.2(b). Rule id: `platform-binary-spawn`.
 * Reference: docs/architecture/target/05-executables.md section 3 rule 1
 *            ("Studio and host never launch binaries as subprocesses").
 *
 * Scope: services/<svc>/<pkg>, studio/<pkg>, plugins/<plugin>/daemon.
 * Detection (static, deliberately conservative): in a file that imports
 * `child_process` / `execa`, a call to spawn/exec/execFile/fork/execa (and their
 * Sync / Command variants) whose argument text contains a string literal naming a
 * platform binary ("kb", "./tools/kb-dev/kb-dev start", "pnpm kb ...", ".../cli/bin/dist/bin.js").
 * Binary names built at runtime from variables are not detectable statically.
 *
 * Devkit custom check (runs once, anchored to @kb-labs/devkit).
 * Standalone: node scripts/checks/check-platform-spawn.mjs [--root <dir>] [--json] [--no-exceptions]
 */

import { pathToFileURL } from 'node:url';

import { findPackages, listSourceFiles, readText, rel, runLint, stripComments } from './lib/boundary-common.mjs';

export const CHECK_NAME = 'platform-spawn';
export const RULE = 'platform-binary-spawn';

const CHILD_PROCESS_IMPORT = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"`](?:node:)?(?:child_process|execa)['"`]/;
// Bare calls, or member calls on a child_process namespace (so `regex.exec("kb")` is not a spawn).
const SPAWN_CALL =
  /(?:(?<![.\w$])|(?<=\b(?:cp|child_process|childProcess|proc|execa)\.))(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|execa|execaSync|execaCommand|execaCommandSync)\s*\(/g;
const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

// [runner prefix] [path/]binary [args...]
const BINARY_LITERAL =
  /^\s*(?:(?:pnpm|npx|yarn|npm\s+exec)\s+(?:exec\s+)?)?(?:.*[\\/])?(kb-create|kb-devkit|kb-dev|kb)(?:\.exe)?(?=\s|$)/;
const CLI_BIN_LITERAL = /(?:^|[\\/\s])cli\/bin\/dist\/bin\.js(?:\s|$)/;

/** Balanced-paren argument text of the call whose "(" is at `open`. */
function callArguments(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1, open + 400);
}

/** @returns {string[]} distinct platform binaries spawned by `source`. */
export function findPlatformBinarySpawns(source) {
  const text = stripComments(source);
  if (!CHILD_PROCESS_IMPORT.test(text)) return [];
  const found = new Set();
  for (const call of text.matchAll(SPAWN_CALL)) {
    const args = callArguments(text, call.index + call[0].length - 1);
    for (const lit of args.matchAll(STRING_LITERAL)) {
      const value = lit[2];
      const bin = BINARY_LITERAL.exec(value);
      if (bin) found.add(bin[1]);
      else if (CLI_BIN_LITERAL.test(value)) found.add('kb');
    }
  }
  return [...found];
}

/** Packages in scope for the rule. */
export function scopedPackages(root) {
  const out = [];
  for (const p of findPackages(root, 'services')) out.push(p);
  for (const p of findPackages(root, 'studio', 2)) out.push(p);
  for (const p of findPackages(root, 'plugins')) {
    if (/^plugins\/[^/]+\/daemon$/.test(p.relDir)) out.push(p);
  }
  return out;
}

export function collect(root) {
  const violations = [];
  for (const pkg of scopedPackages(root)) {
    const hits = new Map();
    for (const file of listSourceFiles(pkg.dir)) {
      for (const bin of findPlatformBinarySpawns(readText(file))) {
        if (!hits.has(bin)) hits.set(bin, rel(root, file));
      }
    }
    for (const [target, file] of hits) {
      violations.push({
        rule: RULE,
        package: pkg.relDir,
        target,
        file,
        message: `${pkg.relDir}: spawns the platform binary "${target}" via child_process (${file}) — services/Studio/daemons must not launch platform binaries`,
        fix: 'Call the host HTTP API or an in-process SDK/core function; lifecycle operations go through the launcher control channel (05-executables.md section 3).',
      });
    }
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runLint({ name: CHECK_NAME, rules: [RULE], collect });
}
