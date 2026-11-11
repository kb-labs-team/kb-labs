#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function main() {
  const input = JSON.parse(await readStdin());
  const issues = [];
  const workspacePackages = input.workspace?.packages;
  if (typeof input.workspaceRoot !== 'string' || !Array.isArray(workspacePackages)) {
    issues.push({ message: 'kb-devkit did not provide its resolved workspace package graph.' });
  } else {
    const packageGraph = workspacePackages.filter((workspacePackage) => workspacePackage.language === 'typescript');
    const packages = [];
    for (const workspacePackage of packageGraph) {
      const manifestPath = path.join(workspacePackage.dir, 'package.json');
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (manifest.name !== workspacePackage.name) {
          issues.push({ message: `Workspace node ${workspacePackage.name} does not match ${manifest.name ?? 'an unnamed package'} in package.json.`, file: manifestPath });
          continue;
        }
        packages.push({
          name: manifest.name,
          dir: workspacePackage.dir,
          role: manifest.kbLabs?.catalogRole,
          dependencies: {
            ...manifest.dependencies,
            ...manifest.optionalDependencies,
            ...manifest.peerDependencies,
          },
        });
      } catch (error) {
        issues.push({ message: `Could not read workspace package metadata: ${error.message}`, file: manifestPath });
      }
    }
    if (packages.length !== packageGraph.length) {
      issues.push({ message: `Catalog role check read ${packages.length} of ${packageGraph.length} registered TypeScript workspace packages.` });
    }
    issues.push(...catalogRoleIssues(packages));
  }
  writeCheckResult(issues.map((issue) => ({ ...issue, check: 'catalog-package-roles', severity: 'error' })));
}

export function catalogRoleIssues(packages) {
  const issues = [];
  const names = new Set(packages.map((pkg) => pkg.name));
  if (names.size !== packages.length) {
    issues.push({ message: 'Resolved workspace graph contains duplicate package identities.' });
  }

  const owners = packages.filter((pkg) => pkg.role === 'owner');
  const writers = packages.filter((pkg) => pkg.role === 'writer');
  const readers = packages.filter((pkg) => pkg.role === 'reader');
  if (owners.length !== 1) issues.push({ message: `Expected one catalog owner role in the workspace graph; found ${owners.length}.` });
  if (writers.length !== 1) issues.push({ message: `Expected one catalog writer role in the workspace graph; found ${writers.length}.` });

  const owner = owners[0];
  const writer = writers[0];
  if (owner && (!owner.dependencies['@kb-labs/core-discovery'] || !owner.dependencies['@kb-labs/plugin-contracts'])) {
    issues.push({ message: `${owner.name} is the catalog owner and must depend on core-discovery and plugin-contracts.` });
  }
  if (writer && (!writer.dependencies['@kb-labs/core-discovery'] || !writer.dependencies['@kb-labs/plugin-contracts'])) {
    issues.push({ message: `${writer.name} is the catalog writer and must depend on core-discovery and plugin-contracts.` });
  }

  for (const pkg of packages) {
    if (pkg.dependencies['@kb-labs/core-discovery'] && pkg !== owner && pkg !== writer) {
      issues.push({ message: `${pkg.name} imports core-discovery outside the catalog-owner and catalog-writer roles; depend on plugin-contracts and open the catalog through the reader role.` });
    }
    if (pkg.role === 'reader' && !pkg.dependencies['@kb-labs/core-registry']) {
      issues.push({ message: `${pkg.name} has the catalog reader role and must depend on core-registry.` });
    }
    if (pkg.dependencies['@kb-labs/core-registry'] && pkg !== owner && pkg.role !== 'reader') {
      issues.push({ message: `${pkg.name} depends on core-registry without the catalog reader role.` });
    }
    if (pkg.role === 'reader' && !pkg.dependencies['@kb-labs/plugin-contracts']) {
      issues.push({ message: `${pkg.name} is a catalog reader in the package graph and must depend on plugin-contracts.` });
    }
    if (pkg.role === 'writer' && pkg.dependencies['@kb-labs/core-registry']) {
      issues.push({ message: `${pkg.name} is a catalog writer and must use plugin-contracts rather than the catalog implementation.` });
    }
  }
  return issues;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
