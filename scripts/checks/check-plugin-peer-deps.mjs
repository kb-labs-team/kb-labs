#!/usr/bin/env node
/**
 * check-plugin-peer-deps — platform packages must be peerDependencies (not
 * dependencies) of plugin packages.
 *
 * Task 0.3. Rule id: `plugin-platform-dependency`.
 * Why: a plugin listing a platform package under `dependencies` makes the package
 * manager install its own private copy of the platform next to the host's, so the
 * plugin talks to a different instance than the one that loads it.
 * Reference: docs/architecture/target/03-domain-model.md (extension model).
 *
 * "Platform package" = `@kb-labs/sdk`, `@kb-labs/core-*`, `@kb-labs/cli-*`,
 * `@kb-labs/shared-*`, `@kb-labs/adapters-*`, `@kb-labs/plugin-{contracts,runtime,execution,
 * execution-factory}`, `@kb-labs/platform-client`. A plugin's own packages
 * (`@kb-labs/commit-core`, ...) are not platform packages and stay ordinary dependencies.
 * `devDependencies` are fine (build/test only) and are not inspected.
 *
 * Scope: plugin entry packages (ship a `kb.plugin/3` manifest; daemons/engines/core under
 * plugins/ are platform parts and out of scope) plus templates/plugin-template.
 * Pre-existing offenders live in scripts/checks/boundary-exceptions.json.
 *
 * Devkit custom check (runs once, anchored to @kb-labs/devkit).
 * Standalone: node scripts/checks/check-plugin-peer-deps.mjs [--root <dir>] [--json] [--no-exceptions]
 */

import { pathToFileURL } from 'node:url';

import { findPackages, findPluginEntryPackages, runLint } from './lib/boundary-common.mjs';

export const CHECK_NAME = 'plugin-peer-deps';
export const RULE = 'plugin-platform-dependency';

// `plugin-*` is listed explicitly (core/plugin-*): a prefix match would also catch plugin-template-* packages.
const PLATFORM_PACKAGE =
  /^@kb-labs\/(?:sdk|platform-client|plugin-(?:contracts|runtime|execution|execution-factory)|(?:core|cli|shared|adapters)-[a-z0-9-]+)$/;

export const isPlatformPackage = (name) => PLATFORM_PACKAGE.test(name);

/** @returns {{ target: string, field: string }[]} platform packages declared outside peerDependencies. */
export function findPlatformRuntimeDeps(pkgJson) {
  const out = [];
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkgJson[field] ?? {})) {
      if (isPlatformPackage(name)) out.push({ target: name, field });
    }
  }
  return out;
}

export function collect(root) {
  const packages = [
    ...findPluginEntryPackages(root),
    ...findPackages(root, 'templates/plugin-template', 2),
  ];
  const violations = [];
  for (const pkg of packages) {
    for (const { target, field } of findPlatformRuntimeDeps(pkg.json)) {
      violations.push({
        rule: RULE,
        package: pkg.relDir,
        target,
        file: `${pkg.relDir}/package.json`,
        message: `${pkg.relDir}: ${target} is in ${field} — platform packages must be peerDependencies in plugins`,
        fix: `Move ${target} to peerDependencies (keep a devDependencies entry for build/tests).`,
      });
    }
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runLint({ name: CHECK_NAME, rules: [RULE], collect });
}
