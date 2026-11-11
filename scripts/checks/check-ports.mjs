#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
/**
 * check-ports — validates port allocation across the monorepo (ADR-0024).
 *
 * Devkit external check (TypedCheckOutput v2). Its anchor package is declared
 * on the custom check in devkit.yaml.
 *   Input:  workspace files and devkit declarations
 *   Output: { issues: [{ check, severity, message, file, fix? }] }
 *
 * Standalone:  node scripts/checks/check-ports.mjs   (human-readable, exit 1 on error)
 *
 * Rules (all severity: error):
 *   UNKNOWN_RANGE              port from devservices is outside every range and not an exception
 *   DUPLICATE_PORT             two distinct services declare the same port
 *   DEVSERVICES_PORT_DISAGREE  same service name has different ports across the two devservices files
 *   PROD_NO_COMPOSE_PORT       prod service (compose:true) has no matching ports: in docker-compose
 *   PROD_CONTAINER_MISMATCH    registry container name != docker-compose container_name
 *   PROD_NO_SMOKE_TEST         prod service has no smoke test in deploy.yml
 *   PROD_PORT_MISMATCH         a deploy smoke-test port matches no prod service in the registry
 *   PROD_SMOKE_PATH_MISMATCH   smoke test hits the right port but the wrong path
 *   STALE_PORTS_DOC            docs/ports.md differs from freshly generated content
 *
 * Reference: docs/adr/0024-port-allocation-policy.md
 */

import { readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import {
  ROOT,
  PATHS,
  loadRegistry,
  loadDevservices,
  loadComposePorts,
  loadComposeContainers,
  loadDeploySmokeTests,
  findDevservicesPortConflicts,
  classifyPort,
  renderDoc,
} from '../lib/ports.mjs';

const CHECK_NAME = 'check-ports';
const DEVKIT_MODE = Boolean(process.env.KB_DEVKIT_MODE);
function rel(p) {
  return relative(ROOT, p);
}

// ─── Validation ────────────────────────────────────────────────────────────────

function validate() {
  const issues = [];
  const registry = loadRegistry();
  const services = loadDevservices();

  // Rule: UNKNOWN_RANGE — every runtime port must classify or be an exception
  for (const svc of services) {
    const { range, exception } = classifyPort(svc.port, registry);
    if (!range && !exception) {
      issues.push({
        check: CHECK_NAME,
        severity: 'error',
        message: `Service "${svc.name}" port ${svc.port} is outside all defined ranges`,
        file: rel(PATHS.devDev),
        fix: `Move it into a range, or add an entry to "exceptions" in ${rel(PATHS.registry)} with a reason`,
      });
    }
  }

  // Rule: DUPLICATE_PORT — two distinct service names sharing a port
  const byPort = new Map();
  for (const svc of services) {
    if (!byPort.has(svc.port)) byPort.set(svc.port, []);
    byPort.get(svc.port).push(svc.name);
  }
  for (const [port, names] of byPort) {
    const uniq = [...new Set(names)];
    if (uniq.length > 1) {
      issues.push({
        check: CHECK_NAME,
        severity: 'error',
        message: `Port ${port} is claimed by multiple services: ${uniq.join(', ')}`,
        file: rel(PATHS.devDev),
        fix: `Assign each service a unique port within its range`,
      });
    }
  }

  // Rule: DEVSERVICES_PORT_DISAGREE — prod-runtime vs dev-runtime port drift
  for (const c of findDevservicesPortConflicts()) {
    issues.push({
      check: CHECK_NAME,
      severity: 'error',
      message: `Service "${c.name}" has different ports across devservices files: ${c.prodPort} (prod-runtime) vs ${c.devPort} (dev-runtime)`,
      file: rel(PATHS.devProd),
      fix: `Make the port for "${c.name}" agree in ${rel(PATHS.devProd)} and ${rel(PATHS.devDev)}`,
    });
  }

  // Prod contract — cross-validate against docker-compose + deploy smoke tests
  const composePorts = loadComposePorts();
  const composeContainers = loadComposeContainers();
  const smokeTests = loadDeploySmokeTests();

  for (const p of registry.prod) {
    if (p.compose) {
      // Rule: PROD_NO_COMPOSE_PORT
      const hostPorts = composePorts.get(p.compose_service) ?? [];
      if (!hostPorts.includes(Number(p.port))) {
        issues.push({
          check: CHECK_NAME,
          severity: 'error',
          message: `Prod service "${p.service}" expects port ${p.port} but compose service "${p.compose_service}" does not map it`,
          file: rel(PATHS.compose),
          fix: `Add  ports: ["${p.port}:${p.port}"]  to "${p.compose_service}" in ${rel(PATHS.compose)}`,
        });
      }

      // Rule: PROD_CONTAINER_MISMATCH — registry container must equal compose container_name
      const composeContainer = composeContainers.get(p.compose_service);
      if (p.container && composeContainer && composeContainer !== p.container) {
        issues.push({
          check: CHECK_NAME,
          severity: 'error',
          message: `Prod service "${p.service}" registry container "${p.container}" != docker-compose container_name "${composeContainer}"`,
          file: rel(PATHS.registry),
          fix: `Set container to "${composeContainer}" in ${rel(PATHS.registry)}, or fix container_name in ${rel(PATHS.compose)} — and ensure deploy.yml rollback uses the same name`,
        });
      }
    }

    // Rule: PROD_NO_SMOKE_TEST / PROD_SMOKE_PATH_MISMATCH
    const smokeAtPort = smokeTests.find((s) => Number(s.port) === Number(p.port));
    if (!smokeAtPort) {
      issues.push({
        check: CHECK_NAME,
        severity: 'error',
        message: `Prod service "${p.service}" (port ${p.port}) has no smoke test in deploy.yml`,
        file: rel(PATHS.deploy),
        fix: `Add  check "${p.service}" "http://localhost:${p.port}${p.smoke_path}"  to the smoke-test step`,
      });
    } else if (smokeAtPort.path !== p.smoke_path) {
      issues.push({
        check: CHECK_NAME,
        severity: 'error',
        message: `Smoke test for port ${p.port} hits "${smokeAtPort.path}" but registry smoke_path is "${p.smoke_path}"`,
        file: rel(PATHS.deploy),
        fix: `Change the smoke test path to "${p.smoke_path}" (or update smoke_path in ${rel(PATHS.registry)})`,
      });
    }
  }

  // Rule: PROD_PORT_MISMATCH — a smoke test whose port matches no prod entry
  // (catches "deploy still points at the old port")
  const prodPorts = new Set(registry.prod.map((p) => Number(p.port)));
  for (const s of smokeTests) {
    if (!prodPorts.has(Number(s.port))) {
      issues.push({
        check: CHECK_NAME,
        severity: 'error',
        message: `Smoke test "${s.name}" targets port ${s.port}, which matches no prod service in the registry`,
        file: rel(PATHS.deploy),
        fix: `Update the smoke test port to match infra/port-registry.yaml, or add the service to the prod list`,
      });
    }
  }

  // Rule: STALE_PORTS_DOC — committed doc must match generated content
  const expected = renderDoc(registry, services) + '\n';
  const actual = existsSync(PATHS.doc) ? readFileSync(PATHS.doc, 'utf8') : '';
  if (actual !== expected) {
    issues.push({
      check: CHECK_NAME,
      severity: 'error',
      message: `docs/ports.md is out of date with the registry`,
      file: rel(PATHS.doc),
      fix: `Run  pnpm ports:generate  and commit the updated docs/ports.md`,
    });
  }

  return issues;
}

// ─── Output ──────────────────────────────────────────────────────────────────

function printHuman(issues) {
  if (issues.length === 0) {
    process.stdout.write('check-ports: OK — no issues\n');
    return;
  }
  for (const i of issues) {
    process.stdout.write(`\n✗ [${i.severity}] ${i.message}\n`);
    process.stdout.write(`  file: ${i.file}\n`);
    if (i.fix) process.stdout.write(`  fix:  ${i.fix}\n`);
  }
  const errors = issues.filter((i) => i.severity === 'error').length;
  process.stdout.write(`\nFound ${errors} error(s).\n`);
}

async function main() {
  if (DEVKIT_MODE) {
    const issues = validate();
    writeCheckResult(issues);
    process.exit(0); // devkit aggregates severity; never hard-fail the runner
  }

  // Standalone
  const issues = validate();
  printHuman(issues);
  process.exit(issues.some((i) => i.severity === 'error') ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n');
  process.exit(1);
});
