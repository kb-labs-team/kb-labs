#!/usr/bin/env node
/**
 * check-plugin-imports — plugins must not import `@kb-labs/core-*` bypassing @kb-labs/sdk.
 *
 * Task 0.2(a). Rule id: `plugin-core-import`.
 * Reference: docs/ARCHITECTURE-BOUNDARIES.md ("plugins -> platform ... bypassing SDK"),
 *            docs/architecture/target/05-executables.md section 3.
 *
 * Scans production sources (tests, fixtures, templates, build output excluded) of every
 * plugin entry package (ships a `kb.plugin/3` manifest; daemons/engines/core are platform
 * parts and out of scope) and templates/plugin-template for import / re-export / dynamic import / require of a
 * `@kb-labs/core-*` specifier. Pre-existing violations live in
 * scripts/checks/boundary-exceptions.json (with date + reason); anything else fails.
 *
 * Devkit custom check (runs once, anchored to @kb-labs/devkit).
 * Standalone: node scripts/checks/check-plugin-imports.mjs [--root <dir>] [--json] [--no-exceptions]
 */

import { pathToFileURL } from 'node:url';

import { findPackages, findPluginEntryPackages, listSourceFiles, readText, rel, runLint, stripComments } from './lib/boundary-common.mjs';

export const CHECK_NAME = 'plugin-imports';
export const RULE = 'plugin-core-import';

const CORE_PACKAGE = /^@kb-labs\/core-[a-z0-9-]+$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"`])([^'"`\n]+)\1/g;

/** Normalise `@scope/name/sub/path` to `@scope/name`. */
function packageOf(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** @returns {string[]} distinct `@kb-labs/core-*` packages imported by `source`. */
export function findCoreImports(source) {
  const found = new Set();
  const text = stripComments(source);
  for (const m of text.matchAll(SPECIFIER)) {
    const pkg = packageOf(m[2]);
    if (pkg && CORE_PACKAGE.test(pkg)) found.add(pkg);
  }
  return [...found];
}

export function collect(root) {
  const violations = [];
  const packages = [...findPluginEntryPackages(root), ...findPackages(root, 'templates/plugin-template', 2)];
  for (const pkg of packages) {
    /** @type {Map<string, string>} target -> first file */
    const hits = new Map();
    for (const file of listSourceFiles(pkg.dir)) {
      for (const target of findCoreImports(readText(file))) {
        if (!hits.has(target)) hits.set(target, rel(root, file));
      }
    }
    for (const [target, file] of hits) {
      violations.push({
        rule: RULE,
        package: pkg.relDir,
        target,
        file,
        message: `${pkg.relDir}: imports ${target} directly (${file}) — plugins must go through @kb-labs/sdk`,
        fix: `Import the needed API from @kb-labs/sdk. If the SDK lacks it, add it to the SDK (docs/ARCHITECTURE-BOUNDARIES.md, "SDK gaps") instead of importing ${target}.`,
      });
    }
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runLint({ name: CHECK_NAME, rules: [RULE], collect });
}
