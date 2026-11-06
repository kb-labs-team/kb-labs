#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
/**
 * check-tool-binaries custom check
 *
 * The Go tool binaries under tools/<name>/<name> are committed to git so that
 * `pnpm build`, `pnpm dev:start`, etc. work without a Go toolchain. The risk is
 * staleness: someone edits a tool's source but forgets to rebuild + commit the
 * binary (e.g. kb-create shipped without --local once).
 *
 * This guard is diff-based, NOT byte-based: the binaries embed version/commit/
 * date via ldflags, so a rebuilt binary never byte-matches. Instead it checks
 * the change set against the base ref — if a tool's Go source changed but its
 * committed binary did not change in the same diff, the binary is stale.
 *
 * Base ref: KB_DEVKIT_BASE_REF (CI sets e.g. "origin/main...HEAD"); falls back
 * to "HEAD" locally (working tree vs last commit = pre-commit semantics).
 *
 * Output format (TypedCheckOutput): { ok, items: [{ target, severity, message, fix }] }
 * Runs with cwd = tool directory. Self-skips non-binary tools (e.g. clikit lib).
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const cwd = process.cwd();
const name = basename(cwd);

function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function emit(result) {
  writeCheckResult(result.items.map(({ target, ...issue }) => ({ ...issue, file: target })));
  process.exit(0);
}

function main() {
  const items = [];

  // Only enforce on tools whose Makefile builds a binary named after the dir.
  const makefile = join(cwd, 'Makefile');
  if (!existsSync(makefile)) return emit({ ok: true, items });
  const mk = readFileSync(makefile, 'utf-8');
  if (!new RegExp(`^BINARY\\s*:?=\\s*${name}\\b`, 'm').test(mk)) {
    return emit({ ok: true, items }); // not a binary tool (e.g. clikit) → skip
  }

  const base = process.env.KB_DEVKIT_BASE_REF || 'HEAD';

  let prefix, changed;
  try {
    prefix = git('rev-parse --show-prefix'); // repo-relative dir, e.g. tools/kb-dev/
    changed = git(`diff --name-only ${base} -- .`).split('\n').filter(Boolean);
  } catch {
    return emit({ ok: true, items }); // base unresolvable (shallow clone, etc.) → skip
  }

  if (changed.length === 0) return emit({ ok: true, items });

  const binPath = `${prefix}${name}`;
  const binChanged = changed.includes(binPath);
  const sourceChanged = changed.some(
    (f) => f !== binPath && /(\.go|\/go\.mod|\/go\.sum|\/Makefile)$/.test(f),
  );

  if (sourceChanged && !binChanged) {
    items.push({
      target: binPath,
      severity: 'error',
      message: `Tool source changed but the committed binary "${binPath}" was not rebuilt — it will be stale. Rebuild and commit it.`,
      fix: `pnpm tools:rebuild && git add ${binPath}`,
    });
  }

  emit({ ok: items.every((i) => i.severity !== 'error'), items });
}

try {
  main();
} catch (err) {
  process.stderr.write(`check-tool-binaries error: ${err.message}\n`);
  process.exit(1);
}
