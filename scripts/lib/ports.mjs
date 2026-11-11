/**
 * Shared port-registry helpers for:
 *   - scripts/checks/check-ports.mjs   (CI validation)
 *   - scripts/generate-ports-doc.mjs   (docs/ports.md generator)
 *
 * Parses the port registry, both devservices runtime files, the prod
 * docker-compose, and the deploy workflow. All paths are resolved from the
 * monorepo root so the helpers work regardless of cwd.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';

// Repo root = two levels up from scripts/lib/
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PATHS = {
  registry: join(ROOT, 'infra', 'port-registry.yaml'),
  devProd: join(ROOT, '.kb', 'devservices.yaml'),
  devDev: join(ROOT, '.kb', 'devservices.dev.yaml'),
  compose: join(ROOT, 'infra', 'docker-compose.backend.yml'),
  deploy: join(ROOT, '.github', 'workflows', 'deploy.yml'),
  doc: join(ROOT, 'docs', 'ports.md'),
};

/** Load and parse the port registry (ranges + exceptions + prod contract). */
export function loadRegistry() {
  const raw = readFileSync(PATHS.registry, 'utf8');
  const reg = parseYaml(raw);
  return {
    version: reg.version,
    ranges: reg.ranges ?? {},
    exceptions: reg.exceptions ?? [],
    prod: reg.prod ?? [],
  };
}

/**
 * Merge both devservices files into a single list of runtime services.
 * A service is keyed by name; the dev file wins on overlap (richer config),
 * but ports must agree (a mismatch surfaces as DUPLICATE_PORT downstream only
 * if the numbers actually collide across distinct names).
 *
 * Returns: [{ name, displayName, port, group, description, source }]
 */
export function loadDevservices() {
  const out = new Map();

  for (const [file, source] of [
    [PATHS.devProd, 'prod-runtime'],
    [PATHS.devDev, 'dev-runtime'],
  ]) {
    if (!existsSync(file)) continue;
    const doc = parseYaml(readFileSync(file, 'utf8'));
    const services = doc?.services ?? {};
    for (const [name, svc] of Object.entries(services)) {
      if (svc == null || typeof svc !== 'object') continue;
      if (svc.port == null) continue; // host-agent / runtime-server have no port
      const existing = out.get(name);
      // dev-runtime overrides prod-runtime for display metadata
      out.set(name, {
        name,
        displayName: svc.name ?? existing?.displayName ?? name,
        port: Number(svc.port),
        group: svc.group ?? existing?.group ?? '',
        description: svc.description ?? existing?.description ?? '',
        optional: Boolean(svc.optional ?? existing?.optional ?? false),
        source: existing ? `${existing.source},${source}` : source,
      });
    }
  }

  return [...out.values()].sort((a, b) => a.port - b.port);
}

/**
 * Parse `ports:` mappings from docker-compose.backend.yml.
 * Returns a map: composeServiceName -> [containerPort, ...]. The port registry
 * owns service ports; the host side may be configured independently by deployment.
 */
export function parseComposePorts(doc) {
  const map = new Map();
  const services = doc?.services ?? {};
  for (const [name, svc] of Object.entries(services)) {
    const ports = Array.isArray(svc?.ports) ? svc.ports : [];
    const containerPorts = ports
      .map((mapping) => {
        const target = mapping != null && typeof mapping === 'object'
          ? mapping.target
          : String(mapping).split(':').at(-1)?.split('/')[0];
        return Number(target);
      })
      .filter((port) => Number.isFinite(port));
    map.set(name, containerPorts);
  }
  return map;
}

export function loadComposePorts() {
  if (!existsSync(PATHS.compose)) return new Map();
  return parseComposePorts(parseYaml(readFileSync(PATHS.compose, 'utf8')));
}

/**
 * Parse `container_name:` from docker-compose.backend.yml.
 * Returns a map: composeServiceName -> container_name (falls back to service name).
 */
export function loadComposeContainers() {
  const map = new Map();
  if (!existsSync(PATHS.compose)) return map;
  const doc = parseYaml(readFileSync(PATHS.compose, 'utf8'));
  const services = doc?.services ?? {};
  for (const [name, svc] of Object.entries(services)) {
    map.set(name, svc?.container_name ?? name);
  }
  return map;
}

/**
 * Detect services declared in BOTH devservices files with disagreeing ports.
 * The prod-runtime (.kb/devservices.yaml) and dev-runtime (.kb/devservices.dev.yaml)
 * must agree on the port for any shared service name.
 * Returns: [{ name, prodPort, devPort }]
 */
export function findDevservicesPortConflicts() {
  const read = (file) => {
    if (!existsSync(file)) return {};
    const doc = parseYaml(readFileSync(file, 'utf8'));
    const out = {};
    for (const [name, svc] of Object.entries(doc?.services ?? {})) {
      if (svc?.port != null) out[name] = Number(svc.port);
    }
    return out;
  };
  const prod = read(PATHS.devProd);
  const dev = read(PATHS.devDev);
  const conflicts = [];
  for (const name of Object.keys(prod)) {
    if (name in dev && prod[name] !== dev[name]) {
      conflicts.push({ name, prodPort: prod[name], devPort: dev[name] });
    }
  }
  return conflicts;
}

/**
 * Extract smoke-test targets from deploy.yml.
 * Matches lines like:  check "marketplace" "http://localhost:5071/health"
 * Returns: [{ name, port, path }]
 */
export function loadDeploySmokeTests() {
  const out = [];
  if (!existsSync(PATHS.deploy)) return out;
  const text = readFileSync(PATHS.deploy, 'utf8');
  const re = /check\s+"([^"]+)"\s+"https?:\/\/localhost:(\d+)(\/[^"]*)?"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ name: m[1], port: Number(m[2]), path: m[3] ?? '/' });
  }
  return out;
}

/**
 * Classify a port into a range name, or 'exception' / null.
 * Returns: { range: string|null, exception: object|null }
 */
export function classifyPort(port, registry) {
  const exc = registry.exceptions.find((e) => Number(e.port) === Number(port));
  if (exc) return { range: null, exception: exc };
  for (const [name, def] of Object.entries(registry.ranges)) {
    if (port >= def.from && port <= def.to) return { range: name, exception: null };
  }
  return { range: null, exception: null };
}

/**
 * Compute a service's scope label by identity: 'prod' if the devservices name is
 * linked from a registry.prod entry via `runtime_service`. Keyed by name, not
 * port — so a dev-only service (e.g. studio:3000) is never mislabeled prod just
 * because its port coincides with a prod service's port (kb-web:3000).
 */
export function scopeForService(name, registry) {
  return registry.prod.some((p) => p.runtime_service === name) ? 'prod' : 'dev';
}

/** Collapse multi-line YAML folded text (criteria) to a single line. */
function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Render the full docs/ports.md content from registry + devservices.
 * Pure function — same inputs always produce the same string, so the
 * staleness check can compare it byte-for-byte against the committed file.
 */
export function renderDoc(registry, services) {
  const lines = [];
  lines.push('# Port Glossary');
  lines.push('');
  lines.push('> **Auto-generated. Do not edit manually.** Run `pnpm ports:generate` to update.');
  lines.push('> Source: `infra/port-registry.yaml` + `.kb/devservices*.yaml`. Policy: [ADR-0024](./adr/0024-port-allocation-policy.md).');
  lines.push('');

  // Decision tree
  lines.push('## Decision Tree');
  lines.push('');
  lines.push('Use this to pick the range for a new service:');
  lines.push('');
  lines.push('```');
  lines.push('Serves HTML to browsers?         → frontend  (3000–3999)');
  lines.push('Routes external traffic?         → gateway   (4000–4099)');
  lines.push('CI/e2e environment only?         → test      (4100–4999)');
  lines.push('Third-party infrastructure?      → infra     (9000–9999)');
  lines.push('HTTP is auxiliary (health/mgmt)? → daemons   (7000–7999)');
  lines.push('Otherwise                        → services  (5000–5999)');
  lines.push('```');
  lines.push('');

  // Ranges
  lines.push('## Port Ranges');
  lines.push('');
  lines.push('| Range | Ports | Description | Criteria |');
  lines.push('|-------|-------|-------------|----------|');
  for (const [name, def] of Object.entries(registry.ranges)) {
    lines.push(
      `| \`${name}\` | ${def.from}–${def.to} | ${oneLine(def.description)} | ${oneLine(def.criteria)} |`,
    );
  }
  lines.push('');

  // Runtime services
  lines.push('## Runtime Services');
  lines.push('');
  lines.push('Ports declared in `.kb/devservices.yaml` / `.kb/devservices.dev.yaml`.');
  lines.push('');
  lines.push('| Port | Service | Range | Scope | Group | Description |');
  lines.push('|------|---------|-------|-------|-------|-------------|');
  for (const svc of services) {
    const { range, exception } = classifyPort(svc.port, registry);
    const rangeLabel = range ?? (exception ? 'exception' : '⚠ unknown');
    const scope = scopeForService(svc.name, registry);
    lines.push(
      `| ${svc.port} | ${svc.displayName} | \`${rangeLabel}\` | ${scope} | ${svc.group} | ${oneLine(svc.description)} |`,
    );
  }
  lines.push('');

  // Exceptions
  if (registry.exceptions.length > 0) {
    lines.push('## Exceptions');
    lines.push('');
    lines.push('Ports intentionally outside the ranges (vendor-fixed defaults).');
    lines.push('');
    lines.push('| Port | Service | Reason |');
    lines.push('|------|---------|--------|');
    for (const e of registry.exceptions) {
      lines.push(`| ${e.port} | ${e.service} | ${oneLine(e.reason)} |`);
    }
    lines.push('');
  }

  // Prod deployment
  lines.push('## Production Deployment');
  lines.push('');
  lines.push('Services deployed to production (validated against docker-compose + deploy smoke tests).');
  lines.push('');
  lines.push('| Port | Service | Container | Smoke path |');
  lines.push('|------|---------|-----------|------------|');
  for (const p of registry.prod) {
    lines.push(`| ${p.port} | ${p.service} | \`${p.container}\` | \`${p.smoke_path}\` |`);
  }
  lines.push('');

  return lines.join('\n');
}
