/**
 * Release status — a read-only "what is actually true right now" view for a
 * flow, cross-checking the surfaces that the 2026-08-13 release-system audit
 * found drifting apart independently: the latest stable git tag, and the
 * real npm dist-tags packages currently resolve to.
 *
 * This does not replace the receipt/state-machine model from the breaking
 * control-plane cutover plan — it is the cheap, non-breaking piece of that
 * diagnosis that can ship today: make "a tag/npm entry exists" and "this was
 * actually verified and promoted" visibly different without any new storage.
 */
import type { ShellAPI } from '@kb-labs/sdk';
import type { ReleaseConfig } from './types';
import { mergeConfigWithFlow, discoverCurrentPackages } from './planner';
import { resolvePublishTag, resolvePublishRegistry } from './channel';
import { DEFAULT_TAG_PATTERN } from './tag';

export interface NpmDistTagInfo {
  name: string;
  stableVersion: string | null;
  canaryVersion: string | null;
  error?: string;
}

export interface StableTagInfo {
  tag: string | null;
  version: string | null;
  commit: string | null;
  committedAt: string | null;
}

export interface FlowReleaseStatus {
  flow: string;
  packages: string[];
  git: StableTagInfo;
  npm: {
    registry: string;
    stableDistTag: string;
    canaryDistTag: string;
    perPackage: NpmDistTagInfo[];
    /** Agreed version across all sampled packages, or null if they disagree or none resolved. */
    stableVersion: string | null;
    canaryVersion: string | null;
    stableDrift: boolean;
    canaryDrift: boolean;
  };
  verdict: {
    ok: boolean;
    warnings: string[];
  };
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)/;

function compareSemver(a: string, b: string): number {
  const ma = a.match(SEMVER_RE);
  const mb = b.match(SEMVER_RE);
  if (!ma || !mb) { return 0; }
  for (let i = 1; i <= 3; i++) {
    const diff = Number(ma[i]) - Number(mb[i]);
    if (diff !== 0) { return diff; }
  }
  return 0;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchDistTags(name: string, registry: string): Promise<Record<string, string> | { error: string }> {
  try {
    const encoded = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : name;
    const url = `${registry.replace(/\/$/, '')}/${encoded}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { return { error: `HTTP ${res.status}` }; }
    const body = (await res.json()) as { 'dist-tags'?: Record<string, string> };
    return body['dist-tags'] ?? {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Latest (by semver) stable release tag for a flow, from real git tags — not from any cached/local state. */
async function findLatestStableTag(
  shell: ShellAPI,
  cwd: string,
  flowName: string,
  tagPattern: string,
): Promise<StableTagInfo> {
  const empty: StableTagInfo = { tag: null, version: null, commit: null, committedAt: null };
  const prefix = tagPattern.split('{version}')[0]?.replace('{flow}', flowName) ?? `${flowName}-v`;

  const listRes = await shell.exec('git', ['tag', '-l', `${prefix}*`], { cwd });
  const tags = listRes.stdout.split('\n').map(t => t.trim()).filter(Boolean);
  if (tags.length === 0) { return empty; }

  const versionRe = new RegExp(`^${escapeRegex(prefix)}(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)$`);
  const parsed = tags
    .map(t => ({ tag: t, version: t.match(versionRe)?.[1] }))
    .filter((t): t is { tag: string; version: string } => Boolean(t.version));
  if (parsed.length === 0) { return empty; }

  parsed.sort((a, b) => compareSemver(a.version, b.version));
  const latest = parsed[parsed.length - 1]!;

  const [shaRes, dateRes] = await Promise.all([
    shell.exec('git', ['rev-list', '-n', '1', latest.tag], { cwd }),
    shell.exec('git', ['log', '-1', '--format=%cI', latest.tag], { cwd }),
  ]);

  return {
    tag: latest.tag,
    version: latest.version,
    commit: shaRes.stdout.trim() || null,
    committedAt: dateRes.stdout.trim() || null,
  };
}

export interface ComputeFlowReleaseStatusOptions {
  cwd: string;
  config: ReleaseConfig;
  flow: string;
  shell: ShellAPI;
  /** How many of the flow's packages to sample against npm. Lockstep flows only need enough to detect drift. Default 3. */
  maxPackagesToCheck?: number;
}

export async function computeFlowReleaseStatus(opts: ComputeFlowReleaseStatusOptions): Promise<FlowReleaseStatus> {
  const { cwd, config, flow, shell, maxPackagesToCheck = 3 } = opts;

  const flowConfig = mergeConfigWithFlow(config, flow);
  const tagPattern = config.flows?.[flow]?.tagPattern ?? DEFAULT_TAG_PATTERN;

  const packages = await discoverCurrentPackages(cwd, undefined, flowConfig);
  // Real npm — canary always publishes here, and `release stable publish` publishes
  // the stable dist-tag here too (config.registry is the pre-promote
  // Verdaccio target, not what end users resolve).
  const registry = resolvePublishRegistry(config, 'canary');
  const stableDistTag = resolvePublishTag(config, 'stable');
  const canaryDistTag = resolvePublishTag(config, 'canary');

  const sampled = packages.slice(0, maxPackagesToCheck);
  const perPackage: NpmDistTagInfo[] = [];
  for (const pkg of sampled) {
    const result = await fetchDistTags(pkg.name, registry);
    if ('error' in result) {
      perPackage.push({ name: pkg.name, stableVersion: null, canaryVersion: null, error: result.error });
    } else {
      perPackage.push({
        name: pkg.name,
        stableVersion: result[stableDistTag] ?? null,
        canaryVersion: result[canaryDistTag] ?? null,
      });
    }
  }

  const stableVersions = new Set(perPackage.map(p => p.stableVersion).filter((v): v is string => Boolean(v)));
  const canaryVersions = new Set(perPackage.map(p => p.canaryVersion).filter((v): v is string => Boolean(v)));

  const git = await findLatestStableTag(shell, cwd, flow, tagPattern);

  const warnings: string[] = [];
  if (stableVersions.size > 1) {
    warnings.push(`Packages disagree on npm "${stableDistTag}" version: ${[...stableVersions].join(', ')}`);
  }
  if (canaryVersions.size > 1) {
    warnings.push(`Packages disagree on npm "${canaryDistTag}" version: ${[...canaryVersions].join(', ')}`);
  }

  const stableVersion = stableVersions.size === 1 ? [...stableVersions][0]! : null;
  const canaryVersion = canaryVersions.size === 1 ? [...canaryVersions][0]! : null;

  if (git.version && stableVersion && git.version !== stableVersion) {
    warnings.push(
      `Latest git tag ${git.tag} (${git.version}) does not match npm "${stableDistTag}" (${stableVersion})`,
    );
  }
  if (stableVersion && canaryVersion && compareSemver(canaryVersion, stableVersion) > 0) {
    warnings.push(
      `npm "${canaryDistTag}" (${canaryVersion}) is ahead of "${stableDistTag}" (${stableVersion}) — ` +
      'treat as an unverified candidate, not a release, until it has a green delivery + smoke run and has been explicitly promoted',
    );
  }

  return {
    flow,
    packages: packages.map(p => p.name),
    git,
    npm: {
      registry,
      stableDistTag,
      canaryDistTag,
      perPackage,
      stableVersion,
      canaryVersion,
      stableDrift: stableVersions.size > 1,
      canaryDrift: canaryVersions.size > 1,
    },
    verdict: {
      ok: warnings.length === 0,
      warnings,
    },
  };
}
